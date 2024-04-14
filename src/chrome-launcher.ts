/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
"use strict";

import * as childProcess from "child_process";
import * as fs from "fs/promises";
import * as fse from "fs-extra";
import * as net from "net";
import * as chromeFinder from "./chrome-finder";
import { getRandomPort } from "./random-port";
import { DEFAULT_FLAGS } from "./flags";
import {
  makeTmpDir,
  defaults,
  delay,
  getPlatform,
  toWin32Path,
  InvalidUserDataDirectoryError,
  UnsupportedPlatformError,
  ChromeNotInstalledError,
} from "./utils";
import { ChildProcess } from "child_process";
import { spawn } from "child_process";
const log = require("lighthouse-logger");
const isWsl = getPlatform() === "wsl";
const isWindows = getPlatform() === "win32";
const _SIGINT = "SIGINT";
const _SIGINT_EXIT_CODE = 130;
const _SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32", "wsl"]);

type SupportedPlatforms = "darwin" | "linux" | "win32" | "wsl";

const instances = new Set<Launcher>();

type JSONLike =
  | { [property: string]: JSONLike }
  | readonly JSONLike[]
  | string
  | number
  | boolean
  | null;

export interface Options {
  startingUrl?: string;
  chromeFlags?: Array<string>;
  prefs?: Record<string, JSONLike>;
  port?: number;
  portStrictMode?: boolean;
  handleSIGINT?: boolean;
  chromePath?: string;
  userDataDir?: string | boolean;
  logLevel?: "verbose" | "info" | "error" | "warn" | "silent";
  ignoreDefaultFlags?: boolean;
  connectionPollInterval?: number;
  maxConnectionRetries?: number;
  envVars?: { [key: string]: string | undefined };
}

export interface LaunchedChrome {
  pid: number;
  port: number;
  process: ChildProcess;
  kill: () => void;
}

export interface ModuleOverrides {
  fs?: typeof fs;
  spawn?: typeof childProcess.spawn;
  fse?: typeof fse;
}

const sigintListener = () => {
  killAll();
  process.exit(_SIGINT_EXIT_CODE);
};

async function launch(opts: Options = {}): Promise<LaunchedChrome> {
  opts.handleSIGINT = defaults(opts.handleSIGINT, true);

  const instance = new Launcher(opts);

  // Kill spawned Chrome process in case of ctrl-C.
  if (opts.handleSIGINT && instances.size === 0) {
    process.on(_SIGINT, sigintListener);
  }
  instances.add(instance);

  await instance.launch();

  const kill = async () => {
    instances.delete(instance);
    if (instances.size === 0) {
      process.removeListener(_SIGINT, sigintListener);
    }
    await instance.kill();
  };

  return {
    pid: instance.pid!,
    port: instance.port!,
    kill,
    process: instance.chromeProcess!,
  };
}

/** Returns Chrome installation path that chrome-launcher will launch by default. */
function getChromePath(): string {
  const installation = Launcher.getFirstInstallation();
  if (!installation) {
    throw new ChromeNotInstalledError();
  }
  return installation;
}

async function killAll(): Promise<Array<Error>> {
  let errors = [];
  for (const instance of instances) {
    try {
      await instance.kill();
      // only delete if kill did not error
      // this means erroring instances remain in the Set
      instances.delete(instance);
    } catch (err) {
      errors.push(err);
    }
  }
  return errors;
}

class Launcher {
  private tmpDirandPidFileReady = false;
  private pidFile: string;
  private startingUrl: string;
  private outFile?: fs.FileHandle;
  private errFile?: fs.FileHandle;
  private chromePath?: string;
  private ignoreDefaultFlags?: boolean;
  private chromeFlags: string[];
  private prefs: Record<string, JSONLike>;
  private requestedPort?: number;
  private portStrictMode?: boolean;
  private connectionPollInterval: number;
  private maxConnectionRetries: number;
  private fs: typeof fs;
  private fse: typeof fse;
  private spawn: typeof childProcess.spawn;
  private useDefaultProfile: boolean;
  private envVars: { [key: string]: string | undefined };

  chromeProcess?: childProcess.ChildProcess;
  userDataDir?: string;
  port?: number;
  pid?: number;

  constructor(
    private opts: Options = {},
    moduleOverrides: ModuleOverrides = {}
  ) {
    this.fs = moduleOverrides.fs || fs;
    this.fse = moduleOverrides.fse || fse;
    this.spawn = moduleOverrides.spawn || spawn;

    log.setLevel(defaults(this.opts.logLevel, "silent"));

    // choose the first one (default)
    this.startingUrl = defaults(this.opts.startingUrl, "about:blank");
    this.chromeFlags = defaults(this.opts.chromeFlags, []);
    this.prefs = defaults(this.opts.prefs, {});
    this.requestedPort = defaults(this.opts.port, 0);
    this.portStrictMode = opts.portStrictMode;
    this.chromePath = this.opts.chromePath;
    this.ignoreDefaultFlags = defaults(this.opts.ignoreDefaultFlags, false);
    this.connectionPollInterval = defaults(
      this.opts.connectionPollInterval,
      500
    );
    this.maxConnectionRetries = defaults(this.opts.maxConnectionRetries, 50);
    this.envVars = defaults(opts.envVars, Object.assign({}, process.env));

    if (typeof this.opts.userDataDir === "boolean") {
      if (!this.opts.userDataDir) {
        this.useDefaultProfile = true;
        this.userDataDir = undefined;
      } else {
        throw new InvalidUserDataDirectoryError();
      }
    } else {
      this.useDefaultProfile = false;
      this.userDataDir = this.opts.userDataDir;
    }
  }

  private get flags() {
    const flags = this.ignoreDefaultFlags ? [] : DEFAULT_FLAGS.slice();
    flags.push(`--remote-debugging-port=${this.port}`);

    if (!this.ignoreDefaultFlags && getPlatform() === "linux") {
      flags.push("--disable-setuid-sandbox");
    }

    if (!this.useDefaultProfile) {
      // Place Chrome profile in a custom location we'll rm -rf later
      // If in WSL, we need to use the Windows format
      flags.push(
        `--user-data-dir=${isWsl ? toWin32Path(this.userDataDir) : this.userDataDir
        }`
      );
    }

    if (process.env.HEADLESS) flags.push("--headless");

    flags.push(...this.chromeFlags);
    flags.push(this.startingUrl);

    return flags;
  }

  static defaultFlags() {
    return DEFAULT_FLAGS.slice();
  }

  /** Returns the highest priority chrome installation. */
  static getFirstInstallation() {
    if (getPlatform() === "darwin") return chromeFinder.darwinFast();
    return chromeFinder[getPlatform() as SupportedPlatforms]()[0];
  }

  /** Returns all available chrome installations in decreasing priority order. */
  static getInstallations() {
    return chromeFinder[getPlatform() as SupportedPlatforms]();
  }

  // Wrapper function to enable easy testing.
  makeTmpDir() {
    return makeTmpDir();
  }

  async prepare() {
    const platform = getPlatform() as SupportedPlatforms;
    if (!_SUPPORTED_PLATFORMS.has(platform)) {
      throw new UnsupportedPlatformError();
    }

    this.userDataDir = this.userDataDir || this.makeTmpDir();
    this.outFile = await this.fs.open(`${this.userDataDir}/chrome-out.log`, "a");
    this.errFile = await this.fs.open(`${this.userDataDir}/chrome-err.log`, "a");

    await this.setBrowserPrefs();

    // fix for Node4
    // you can't pass a fd to fs.writeFileSync
    this.pidFile = `${this.userDataDir}/chrome.pid`;

    log.verbose("ChromeLauncher", `created ${this.userDataDir}`);

    this.tmpDirandPidFileReady = true;
  }

  private async setBrowserPrefs() {
    // don't set prefs if not defined
    if (Object.keys(this.prefs).length === 0) {
      return;
    }

    const profileDir = `${this.userDataDir}/Default`;
    if (!(await this.fse.pathExists(profileDir))) {
      await this.fs.mkdir(profileDir, { recursive: true });
    }

    const preferenceFile = `${profileDir}/Preferences`;
    try {
      if ((await this.fse.pathExists(preferenceFile))) {
        // overwrite existing file
        const file = await this.fs.readFile(preferenceFile, "utf-8");
        const content = JSON.parse(file);
        await this.fs.writeFile(
          preferenceFile,
          JSON.stringify({ ...content, ...this.prefs }),
          "utf-8"
        );
      } else {
        // create new Preference file
        await this.fs.writeFile(
          preferenceFile,
          JSON.stringify({ ...this.prefs }),
          "utf-8"
        );
      }
    } catch (err) {
      log.log("ChromeLauncher", `Failed to set browser prefs: ${err.message}`);
    }
  }

  async launch() {
    if (this.requestedPort !== 0) {
      this.port = this.requestedPort;

      // If an explict port is passed first look for an open connection...
      try {
        await this.isDebuggerReady();
        log.log(
          "ChromeLauncher",
          `Found existing Chrome already running using port ${this.port}, using that.`
        );
        return;
      } catch (err) {
        if (this.portStrictMode) {
          throw new Error(`found no Chrome at port ${this.requestedPort}`);
        }

        log.log(
          "ChromeLauncher",
          `No debugging port found on port ${this.port}, launching a new Chrome.`
        );
      }
    }
    if (this.chromePath === undefined) {
      const installation = Launcher.getFirstInstallation();
      if (!installation) {
        throw new ChromeNotInstalledError();
      }

      this.chromePath = installation;
    }

    if (!this.tmpDirandPidFileReady) {
      await this.prepare();
    }

    this.pid = await this.spawnProcess(this.chromePath);
    return Promise.resolve();
  }

  private async spawnProcess(execPath: string) {
    const spawnPromise = (async () => {
      if (this.chromeProcess) {
        log.log(
          "ChromeLauncher",
          `Chrome already running with pid ${this.chromeProcess.pid}.`
        );
        return this.chromeProcess.pid;
      }

      // If a zero value port is set, it means the launcher
      // is responsible for generating the port number.
      // We do this here so that we can know the port before
      // we pass it into chrome.
      if (this.requestedPort === 0) {
        this.port = await getRandomPort();
      }

      log.verbose(
        "ChromeLauncher",
        `Launching with command:\n"${execPath}" ${this.flags.join(" ")}`
      );
      this.chromeProcess = this.spawn(execPath, this.flags, {
        // On non-windows platforms, `detached: true` makes child process a leader of a new
        // process group, making it possible to kill child process tree with `.kill(-pid)` command.
        // @see https://nodejs.org/api/child_process.html#child_process_options_detached
        detached: process.platform !== "win32",
        stdio: ["ignore", this.outFile?.fd, this.errFile?.fd],
        env: this.envVars,
      });

      if (!this.chromeProcess) {
        throw new Error("Chrome process not created");
      }

      if (this.chromeProcess?.pid) {
        await this.fs.writeFile(this.pidFile, this.chromeProcess.pid.toString());
      }

      log.verbose(
        "ChromeLauncher",
        `Chrome running with pid ${this.chromeProcess?.pid} on port ${this.port}.`
      );
      return this.chromeProcess?.pid;
    })();

    const pid = await spawnPromise;
    await this.waitUntilReady();
    return pid;
  }

  private cleanup(client?: net.Socket) {
    if (client) {
      client.removeAllListeners();
      client.end();
      client.destroy();
      client.unref();
    }
  }

  // resolves if ready, rejects otherwise
  private isDebuggerReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.port!, "127.0.0.1");
      client.once("error", (err) => {
        this.cleanup(client);
        reject(err);
      });
      client.once("connect", () => {
        this.cleanup(client);
        resolve();
      });
    });
  }

  // resolves when debugger is ready, rejects after 10 polls
  waitUntilReady() {
    const launcher = this;

    return new Promise<void>((resolve, reject) => {
      let retries = 0;
      let waitStatus = "Waiting for browser.";

      const poll = async () => {
        if (retries === 0) {
          log.log("ChromeLauncher", waitStatus);
        }
        retries++;
        waitStatus += "..";
        log.log("ChromeLauncher", waitStatus);

        try {
          await launcher.isDebuggerReady()

          log.log("ChromeLauncher", waitStatus + `${log.greenify(log.tick)}`);
          resolve();
        } catch (err) {
          if (retries > launcher.maxConnectionRetries) {
            log.error("ChromeLauncher", err.message);
            const stderr = await this.fs.readFile(
              `${this.userDataDir}/chrome-err.log`,
              { encoding: "utf-8" }
            );
            log.error(
              "ChromeLauncher",
              `Logging contents of ${this.userDataDir}/chrome-err.log`
            );
            log.error("ChromeLauncher", stderr);
            return reject(err);
          }
          delay(launcher.connectionPollInterval).then(poll);
        }
      };
      poll();
    });
  }

  async kill() {
    return new Promise<void>(async (resolve) => {
      if (!this.chromeProcess) {
        return resolve()
      }

      this.chromeProcess.on("close", async () => {
        delete this.chromeProcess;
        await this.destroyTmp();
        resolve();
      });

      log.log(
        "ChromeLauncher",
        `Killing Chrome instance ${this.chromeProcess.pid}`
      );
      try {
        if (isWindows) {
          childProcess.exec(
            `taskkill /pid ${this.chromeProcess.pid} /T /F`,
            (error: Error | null) => {
              if (error) {
                // taskkill can fail to kill the process e.g. due to missing permissions.
                // Let's kill the process via Node API. This delays killing of all child
                // proccesses of `this.proc` until the main Node.js process dies.
                this.chromeProcess?.kill();
              }
            }
          );
        } else {
          if (this.chromeProcess.pid) {
            process.kill(-this.chromeProcess.pid, "SIGKILL");
          }
        }
      } catch (err) {
        const message = `Chrome could not be killed ${err.message}`;
        log.warn("ChromeLauncher", message);
      }

      await this.destroyTmp();

      resolve()
    })
  }

  async destroyTmp() {
    if (this.outFile) {
      await this.outFile.close().catch(err => console.error('Failed to close outFile:', err));
    }

    // Only clean up the tmp dir if we created it.
    if (this.userDataDir === undefined || this.opts.userDataDir !== undefined) {
      return;
    }

    if (this.errFile) {
      await this.errFile.close().catch(err => console.error('Failed to close errFile:', err));
    }

    // Use the fs.rm method, available in Node.js since v14.14 as an alternative to rmSync
    // and it supports promises.
    try {
      await this.fs.rm(this.userDataDir, { recursive: true, force: true, maxRetries: 30 });
    } catch (error) {
      console.error('Failed to remove userDataDir:', error);
    }
  }
}

export default Launcher;
export { Launcher, launch, killAll, getChromePath };
