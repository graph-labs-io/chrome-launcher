/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChromePath = exports.killAll = exports.launch = exports.Launcher = void 0;
const childProcess = require("child_process");
const fs = require("fs/promises");
const fse = require("fs-extra");
const net = require("net");
const chromeFinder = require("./chrome-finder");
const random_port_1 = require("./random-port");
const flags_1 = require("./flags");
const utils_1 = require("./utils");
const child_process_1 = require("child_process");
const log = require("lighthouse-logger");
const isWsl = utils_1.getPlatform() === "wsl";
const isWindows = utils_1.getPlatform() === "win32";
const _SIGINT = "SIGINT";
const _SIGINT_EXIT_CODE = 130;
const _SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32", "wsl"]);
const instances = new Set();
const sigintListener = () => {
    killAll();
    process.exit(_SIGINT_EXIT_CODE);
};
async function launch(opts = {}) {
    opts.handleSIGINT = utils_1.defaults(opts.handleSIGINT, true);
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
        pid: instance.pid,
        port: instance.port,
        kill,
        process: instance.chromeProcess,
    };
}
exports.launch = launch;
/** Returns Chrome installation path that chrome-launcher will launch by default. */
function getChromePath() {
    const installation = Launcher.getFirstInstallation();
    if (!installation) {
        throw new utils_1.ChromeNotInstalledError();
    }
    return installation;
}
exports.getChromePath = getChromePath;
async function killAll() {
    let errors = [];
    for (const instance of instances) {
        try {
            await instance.kill();
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
exports.killAll = killAll;
class Launcher {
    constructor(opts = {}, moduleOverrides = {}) {
        this.opts = opts;
        this.tmpDirandPidFileReady = false;
        this.fs = moduleOverrides.fs || fs;
        this.fse = moduleOverrides.fse || fse;
        this.spawn = moduleOverrides.spawn || child_process_1.spawn;
        log.setLevel(utils_1.defaults(this.opts.logLevel, "silent"));
        // choose the first one (default)
        this.startingUrl = utils_1.defaults(this.opts.startingUrl, "about:blank");
        this.chromeFlags = utils_1.defaults(this.opts.chromeFlags, []);
        this.prefs = utils_1.defaults(this.opts.prefs, {});
        this.requestedPort = utils_1.defaults(this.opts.port, 0);
        this.portStrictMode = opts.portStrictMode;
        this.chromePath = this.opts.chromePath;
        this.ignoreDefaultFlags = utils_1.defaults(this.opts.ignoreDefaultFlags, false);
        this.connectionPollInterval = utils_1.defaults(this.opts.connectionPollInterval, 500);
        this.maxConnectionRetries = utils_1.defaults(this.opts.maxConnectionRetries, 50);
        this.envVars = utils_1.defaults(opts.envVars, Object.assign({}, process.env));
        if (typeof this.opts.userDataDir === "boolean") {
            if (!this.opts.userDataDir) {
                this.useDefaultProfile = true;
                this.userDataDir = undefined;
            }
            else {
                throw new utils_1.InvalidUserDataDirectoryError();
            }
        }
        else {
            this.useDefaultProfile = false;
            this.userDataDir = this.opts.userDataDir;
        }
    }
    get flags() {
        const flags = this.ignoreDefaultFlags ? [] : flags_1.DEFAULT_FLAGS.slice();
        flags.push(`--remote-debugging-port=${this.port}`);
        if (!this.ignoreDefaultFlags && utils_1.getPlatform() === "linux") {
            flags.push("--disable-setuid-sandbox");
        }
        if (!this.useDefaultProfile) {
            // Place Chrome profile in a custom location we'll rm -rf later
            // If in WSL, we need to use the Windows format
            flags.push(`--user-data-dir=${isWsl ? utils_1.toWin32Path(this.userDataDir) : this.userDataDir}`);
        }
        if (process.env.HEADLESS)
            flags.push("--headless");
        flags.push(...this.chromeFlags);
        flags.push(this.startingUrl);
        return flags;
    }
    static defaultFlags() {
        return flags_1.DEFAULT_FLAGS.slice();
    }
    /** Returns the highest priority chrome installation. */
    static getFirstInstallation() {
        if (utils_1.getPlatform() === "darwin")
            return chromeFinder.darwinFast();
        return chromeFinder[utils_1.getPlatform()]()[0];
    }
    /** Returns all available chrome installations in decreasing priority order. */
    static getInstallations() {
        return chromeFinder[utils_1.getPlatform()]();
    }
    // Wrapper function to enable easy testing.
    makeTmpDir() {
        return utils_1.makeTmpDir();
    }
    async prepare() {
        const platform = utils_1.getPlatform();
        if (!_SUPPORTED_PLATFORMS.has(platform)) {
            throw new utils_1.UnsupportedPlatformError();
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
    async setBrowserPrefs() {
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
                await this.fs.writeFile(preferenceFile, JSON.stringify({ ...content, ...this.prefs }), "utf-8");
            }
            else {
                // create new Preference file
                await this.fs.writeFile(preferenceFile, JSON.stringify({ ...this.prefs }), "utf-8");
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
                throw new utils_1.ChromeNotInstalledError();
            }
            this.chromePath = installation;
        }
        if (!this.tmpDirandPidFileReady) {
            await this.prepare();
        }
        this.pid = await this.spawnProcess(this.chromePath);
        return Promise.resolve();
    }
    async spawnProcess(execPath) {
        const spawnPromise = (async () => {
            var _a, _b, _c, _d, _e;
            if (this.chromeProcess) {
                log.log("ChromeLauncher", `Chrome already running with pid ${this.chromeProcess.pid}.`);
                return this.chromeProcess.pid;
            }
            // If a zero value port is set, it means the launcher
            // is responsible for generating the port number.
            // We do this here so that we can know the port before
            // we pass it into chrome.
            if (this.requestedPort === 0) {
                this.port = await random_port_1.getRandomPort();
            }
            log.verbose("ChromeLauncher", `Launching with command:\n"${execPath}" ${this.flags.join(" ")}`);
            this.chromeProcess = this.spawn(execPath, this.flags, {
                // On non-windows platforms, `detached: true` makes child process a leader of a new
                // process group, making it possible to kill child process tree with `.kill(-pid)` command.
                // @see https://nodejs.org/api/child_process.html#child_process_options_detached
                detached: process.platform !== "win32",
                stdio: ["ignore", (_a = this.outFile) === null || _a === void 0 ? void 0 : _a.fd, (_b = this.errFile) === null || _b === void 0 ? void 0 : _b.fd],
                env: this.envVars,
            });
            if (!this.chromeProcess) {
                throw new Error("Chrome process not created");
            }
            if ((_c = this.chromeProcess) === null || _c === void 0 ? void 0 : _c.pid) {
                await this.fs.writeFile(this.pidFile, this.chromeProcess.pid.toString());
            }
            log.verbose("ChromeLauncher", `Chrome running with pid ${(_d = this.chromeProcess) === null || _d === void 0 ? void 0 : _d.pid} on port ${this.port}.`);
            return (_e = this.chromeProcess) === null || _e === void 0 ? void 0 : _e.pid;
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
            const poll = async () => {
                if (retries === 0) {
                    log.log("ChromeLauncher", waitStatus);
                }
                retries++;
                waitStatus += "..";
                log.log("ChromeLauncher", waitStatus);
                try {
                    await launcher.isDebuggerReady();
                    log.log("ChromeLauncher", waitStatus + `${log.greenify(log.tick)}`);
                    resolve();
                }
                catch (err) {
                    if (retries > launcher.maxConnectionRetries) {
                        log.error("ChromeLauncher", err.message);
                        const stderr = await this.fs.readFile(`${this.userDataDir}/chrome-err.log`, { encoding: "utf-8" });
                        log.error("ChromeLauncher", `Logging contents of ${this.userDataDir}/chrome-err.log`);
                        log.error("ChromeLauncher", stderr);
                        return reject(err);
                    }
                    utils_1.delay(launcher.connectionPollInterval).then(poll);
                }
            };
            poll();
        });
    }
    async kill() {
        return new Promise(async (resolve) => {
            if (!this.chromeProcess) {
                return resolve();
            }
            this.chromeProcess.on("close", async () => {
                delete this.chromeProcess;
                await this.destroyTmp();
                resolve();
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
            await this.destroyTmp();
            resolve();
        });
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
        }
        catch (error) {
            console.error('Failed to remove userDataDir:', error);
        }
    }
}
exports.Launcher = Launcher;
exports.default = Launcher;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hyb21lLWxhdW5jaGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2Nocm9tZS1sYXVuY2hlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7OztHQUlHO0FBQ0gsWUFBWSxDQUFDOzs7QUFFYiw4Q0FBOEM7QUFDOUMsa0NBQWtDO0FBQ2xDLGdDQUFnQztBQUNoQywyQkFBMkI7QUFDM0IsZ0RBQWdEO0FBQ2hELCtDQUE4QztBQUM5QyxtQ0FBd0M7QUFDeEMsbUNBU2lCO0FBRWpCLGlEQUFzQztBQUN0QyxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsbUJBQW1CLENBQUMsQ0FBQztBQUN6QyxNQUFNLEtBQUssR0FBRyxtQkFBVyxFQUFFLEtBQUssS0FBSyxDQUFDO0FBQ3RDLE1BQU0sU0FBUyxHQUFHLG1CQUFXLEVBQUUsS0FBSyxPQUFPLENBQUM7QUFDNUMsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDO0FBQ3pCLE1BQU0saUJBQWlCLEdBQUcsR0FBRyxDQUFDO0FBQzlCLE1BQU0sb0JBQW9CLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxRQUFRLEVBQUUsT0FBTyxFQUFFLE9BQU8sRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBSTFFLE1BQU0sU0FBUyxHQUFHLElBQUksR0FBRyxFQUFZLENBQUM7QUF1Q3RDLE1BQU0sY0FBYyxHQUFHLEdBQUcsRUFBRTtJQUMxQixPQUFPLEVBQUUsQ0FBQztJQUNWLE9BQU8sQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsQ0FBQztBQUNsQyxDQUFDLENBQUM7QUFFRixLQUFLLFVBQVUsTUFBTSxDQUFDLE9BQWdCLEVBQUU7SUFDdEMsSUFBSSxDQUFDLFlBQVksR0FBRyxnQkFBUSxDQUFDLElBQUksQ0FBQyxZQUFZLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFFdEQsTUFBTSxRQUFRLEdBQUcsSUFBSSxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7SUFFcEMsaURBQWlEO0lBQ2pELElBQUks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