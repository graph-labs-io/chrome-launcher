/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
"use strict";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as chromeFinder from "./chrome-finder.js";
import { getRandomPort } from "./random-port.js";
import { DEFAULT_FLAGS } from "./flags.js";
import { makeTmpDir, defaults, delay, getPlatform, toWin32Path, InvalidUserDataDirectoryError, UnsupportedPlatformError, ChromeNotInstalledError, } from "./utils.js";
import { spawn } from "child_process";
import log from "lighthouse-logger";
const isWsl = getPlatform() === "wsl";
const isWindows = getPlatform() === "win32";
const _SIGINT = "SIGINT";
const _SIGINT_EXIT_CODE = 130;
const _SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32", "wsl"]);
const instances = new Set();
const sigintListener = () => {
    killAll();
    process.exit(_SIGINT_EXIT_CODE);
};
async function launch(opts = {}) {
    opts.handleSIGINT = defaults(opts.handleSIGINT, true);
    const instance = new Launcher(opts);
    // Kill spawned Chrome process in case of ctrl-C.
    if (opts.handleSIGINT && instances.size === 0) {
        process.on(_SIGINT, sigintListener);
    }
    instances.add(instance);
    await instance.launch();
    const kill = () => {
        instances.delete(instance);
        if (instances.size === 0) {
            process.removeListener(_SIGINT, sigintListener);
        }
        instance.kill();
    };
    return {
        pid: instance.pid,
        port: instance.port,
        kill,
        process: instance.chromeProcess,
    };
}
/** Returns Chrome installation path that chrome-launcher will launch by default. */
function getChromePath() {
    const installation = Launcher.getFirstInstallation();
    if (!installation) {
        throw new ChromeNotInstalledError();
    }
    return installation;
}
function killAll() {
    let errors = [];
    for (const instance of instances) {
        try {
            instance.kill();
            // only delete if kill did not error
            // this means erroring instances remain in the Set
            instances.delete(instance);
        }
        catch (err) {
            errors.push(err);
        }
    }
    return errors;
}
class Launcher {
    constructor(opts = {}, moduleOverrides = {}) {
        this.opts = opts;
        this.tmpDirandPidFileReady = false;
        this.fs = moduleOverrides.fs || fs;
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
        this.connectionPollInterval = defaults(this.opts.connectionPollInterval, 500);
        this.maxConnectionRetries = defaults(this.opts.maxConnectionRetries, 50);
        this.envVars = defaults(opts.envVars, Object.assign({}, process.env));
        if (typeof this.opts.userDataDir === "boolean") {
            if (!this.opts.userDataDir) {
                this.useDefaultProfile = true;
                this.userDataDir = undefined;
            }
            else {
                throw new InvalidUserDataDirectoryError();
            }
        }
        else {
            this.useDefaultProfile = false;
            this.userDataDir = this.opts.userDataDir;
        }
    }
    get flags() {
        const flags = this.ignoreDefaultFlags ? [] : DEFAULT_FLAGS.slice();
        flags.push(`--remote-debugging-port=${this.port}`);
        if (!this.ignoreDefaultFlags && getPlatform() === "linux") {
            flags.push("--disable-setuid-sandbox");
        }
        if (!this.useDefaultProfile) {
            // Place Chrome profile in a custom location we'll rm -rf later
            // If in WSL, we need to use the Windows format
            flags.push(`--user-data-dir=${isWsl ? toWin32Path(this.userDataDir) : this.userDataDir}`);
        }
        if (process.env.HEADLESS)
            flags.push("--headless");
        flags.push(...this.chromeFlags);
        flags.push(this.startingUrl);
        return flags;
    }
    static defaultFlags() {
        return DEFAULT_FLAGS.slice();
    }
    /** Returns the highest priority chrome installation. */
    static getFirstInstallation() {
        if (getPlatform() === "darwin")
            return chromeFinder.darwinFast();
        return chromeFinder[getPlatform()]()[0];
    }
    /** Returns all available chrome installations in decreasing priority order. */
    static getInstallations() {
        return chromeFinder[getPlatform()]();
    }
    // Wrapper function to enable easy testing.
    makeTmpDir() {
        return makeTmpDir();
    }
    prepare() {
        const platform = getPlatform();
        if (!_SUPPORTED_PLATFORMS.has(platform)) {
            throw new UnsupportedPlatformError();
        }
        this.userDataDir = this.userDataDir || this.makeTmpDir();
        this.outFile = this.fs.openSync(`${this.userDataDir}/chrome-out.log`, "a");
        this.errFile = this.fs.openSync(`${this.userDataDir}/chrome-err.log`, "a");
        this.setBrowserPrefs();
        // fix for Node4
        // you can't pass a fd to fs.writeFileSync
        this.pidFile = `${this.userDataDir}/chrome.pid`;
        log.verbose("ChromeLauncher", `created ${this.userDataDir}`);
        this.tmpDirandPidFileReady = true;
    }
    setBrowserPrefs() {
        // don't set prefs if not defined
        if (Object.keys(this.prefs).length === 0) {
            return;
        }
        const profileDir = `${this.userDataDir}/Default`;
        if (!this.fs.existsSync(profileDir)) {
            this.fs.mkdirSync(profileDir, { recursive: true });
        }
        const preferenceFile = `${profileDir}/Preferences`;
        try {
            if (this.fs.existsSync(preferenceFile)) {
                // overwrite existing file
                const file = this.fs.readFileSync(preferenceFile, "utf-8");
                const content = JSON.parse(file);
                this.fs.writeFileSync(preferenceFile, JSON.stringify({ ...content, ...this.prefs }), "utf-8");
            }
            else {
                // create new Preference file
                this.fs.writeFileSync(preferenceFile, JSON.stringify({ ...this.prefs }), "utf-8");
            }
        }
        catch (err) {
            log.log("ChromeLauncher", `Failed to set browser prefs: ${err.message}`);
        }
    }
    async launch() {
        if (this.requestedPort !== 0) {
            this.port = this.requestedPort;
            // If an explict port is passed first look for an open connection...
            try {
                await this.isDebuggerReady();
                log.log("ChromeLauncher", `Found existing Chrome already running using port ${this.port}, using that.`);
                return;
            }
            catch (err) {
                if (this.portStrictMode) {
                    throw new Error(`found no Chrome at port ${this.requestedPort}`);
                }
                log.log("ChromeLauncher", `No debugging port found on port ${this.port}, launching a new Chrome.`);
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
            this.prepare();
        }
        this.pid = await this.spawnProcess(this.chromePath);
        return Promise.resolve();
    }
    async spawnProcess(execPath) {
        const spawnPromise = (async () => {
            if (this.chromeProcess) {
                log.log("ChromeLauncher", `Chrome already running with pid ${this.chromeProcess.pid}.`);
                return this.chromeProcess.pid;
            }
            // If a zero value port is set, it means the launcher
            // is responsible for generating the port number.
            // We do this here so that we can know the port before
            // we pass it into chrome.
            if (this.requestedPort === 0) {
                this.port = await getRandomPort();
            }
            log.verbose("ChromeLauncher", `Launching with command:\n"${execPath}" ${this.flags.join(" ")}`);
            this.chromeProcess = this.spawn(execPath, this.flags, {
                // On non-windows platforms, `detached: true` makes child process a leader of a new
                // process group, making it possible to kill child process tree with `.kill(-pid)` command.
                // @see https://nodejs.org/api/child_process.html#child_process_options_detached
                detached: process.platform !== "win32",
                stdio: ["ignore", this.outFile, this.errFile],
                env: this.envVars,
            });
            if (this.chromeProcess.pid) {
                this.fs.writeFileSync(this.pidFile, this.chromeProcess.pid.toString());
            }
            log.verbose("ChromeLauncher", `Chrome running with pid ${this.chromeProcess.pid} on port ${this.port}.`);
            return this.chromeProcess.pid;
        })();
        const pid = await spawnPromise;
        await this.waitUntilReady();
        return pid;
    }
    cleanup(client) {
        if (client) {
            client.removeAllListeners();
            client.end();
            client.destroy();
            client.unref();
        }
    }
    // resolves if ready, rejects otherwise
    isDebuggerReady() {
        return new Promise((resolve, reject) => {
            const client = net.createConnection(this.port, "127.0.0.1");
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
        return new Promise((resolve, reject) => {
            let retries = 0;
            let waitStatus = "Waiting for browser.";
            const poll = () => {
                if (retries === 0) {
                    log.log("ChromeLauncher", waitStatus);
                }
                retries++;
                waitStatus += "..";
                log.log("ChromeLauncher", waitStatus);
                launcher
                    .isDebuggerReady()
                    .then(() => {
                    log.log("ChromeLauncher", waitStatus + `${log.greenify(log.tick)}`);
                    resolve();
                })
                    .catch((err) => {
                    if (retries > launcher.maxConnectionRetries) {
                        log.error("ChromeLauncher", err.message);
                        const stderr = this.fs.readFileSync(`${this.userDataDir}/chrome-err.log`, { encoding: "utf-8" });
                        log.error("ChromeLauncher", `Logging contents of ${this.userDataDir}/chrome-err.log`);
                        log.error("ChromeLauncher", stderr);
                        return reject(err);
                    }
                    delay(launcher.connectionPollInterval).then(poll);
                });
            };
            poll();
        });
    }
    kill() {
        if (!this.chromeProcess) {
            return;
        }
        this.chromeProcess.on("close", () => {
            delete this.chromeProcess;
            this.destroyTmp();
        });
        log.log("ChromeLauncher", `Killing Chrome instance ${this.chromeProcess.pid}`);
        try {
            if (isWindows) {
                childProcess.exec(`taskkill /pid ${this.chromeProcess.pid} /T /F`, (error) => {
                    var _a;
                    if (error) {
                        // taskkill can fail to kill the process e.g. due to missing permissions.
                        // Let's kill the process via Node API. This delays killing of all child
                        // proccesses of `this.proc` until the main Node.js process dies.
                        (_a = this.chromeProcess) === null || _a === void 0 ? void 0 : _a.kill();
                    }
                });
            }
            else {
                if (this.chromeProcess.pid) {
                    process.kill(-this.chromeProcess.pid, "SIGKILL");
                }
            }
        }
        catch (err) {
            const message = `Chrome could not be killed ${err.message}`;
            log.warn("ChromeLauncher", message);
        }
        this.destroyTmp();
    }
    destroyTmp() {
        if (this.outFile) {
            this.fs.closeSync(this.outFile);
            delete this.outFile;
        }
        // Only clean up the tmp dir if we created it.
        if (this.userDataDir === undefined || this.opts.userDataDir !== undefined) {
            return;
        }
        if (this.errFile) {
            this.fs.closeSync(this.errFile);
            delete this.errFile;
        }
        // backwards support for node v12 + v14.14+
        // https://nodejs.org/api/deprecations.html#DEP0147
        const rmSync = this.fs.rmSync || this.fs.rmdirSync;
        rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 10 });
    }
}
export default Launcher;
export { Launcher, launch, killAll, getChromePath };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hyb21lLWxhdW5jaGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2Nocm9tZS1sYXVuY2hlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7OztHQUlHO0FBQ0gsWUFBWSxDQUFDO0FBRWIsT0FBTyxLQUFLLFlBQVksTUFBTSxlQUFlLENBQUM7QUFDOUMsT0FBTyxLQUFLLEVBQUUsTUFBTSxJQUFJLENBQUM7QUFDekIsT0FBTyxLQUFLLEdBQUcsTUFBTSxLQUFLLENBQUM7QUFDM0IsT0FBTyxLQUFLLFlBQVksTUFBTSxvQkFBb0IsQ0FBQztBQUNuRCxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDakQsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLFlBQVksQ0FBQztBQUMzQyxPQUFPLEVBQ0wsVUFBVSxFQUNWLFFBQVEsRUFDUixLQUFLLEVBQ0wsV0FBVyxFQUNYLFdBQVcsRUFDWCw2QkFBNkIsRUFDN0Isd0JBQXdCLEVBQ3hCLHVCQUF1QixHQUN4QixNQUFNLFlBQVksQ0FBQztBQUVwQixPQUFPLEVBQUUsS0FBSyxFQUFFLE1BQU0sZUFBZSxDQUFDO0FBQ3RDLE9BQU8sR0FBRyxNQUFNLG1CQUFtQixDQUFDO0FBRXBDLE1BQU0sS0FBSyxHQUFHLFdBQVcsRUFBRSxLQUFLLEtBQUssQ0FBQztBQUN0QyxNQUFNLFNBQVMsR0FBRyxXQUFXLEVBQUUsS0FBSyxPQUFPLENBQUM7QUFDNUMsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDO0FBQ3pCLE1BQU0saUJBQWlCLEdBQUcsR0FBRyxDQUFDO0FBQzlCLE1BQU0sb0JBQW9CLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxRQUFRLEVBQUUsT0FBTyxFQUFFLE9BQU8sRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBSTFFLE1BQU0sU0FBUyxHQUFHLElBQUksR0FBRyxFQUFZLENBQUM7QUFzQ3RDLE1BQU0sY0FBYyxHQUFHLEdBQUcsRUFBRTtJQUMxQixP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