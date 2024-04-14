/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

import { Launcher, launch, killAll, Options, getChromePath } from '../src/chrome-launcher';
import { DEFAULT_FLAGS } from '../src/flags';

import { spy, stub } from 'sinon';
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as fse from 'fs-extra';

const log = require('lighthouse-logger');
const fsMock = {
  open: () => { },
  close: () => { },
  writeFile: () => { },
  rm: () => { },
};

const fseMock = {
  pathExists: () => { },
};

const launchChromeWithOpts = async (opts: Options = {}) => {
  const spawnStub = stub().returns({ pid: 'some_pid' });

  const chromeInstance =
    new Launcher(opts, { fs: fsMock as any, fse: fseMock as any, spawn: spawnStub as any });
  stub(chromeInstance, 'waitUntilReady').returns(Promise.resolve());

  await chromeInstance.prepare();

  try {
    await chromeInstance.launch();
    return Promise.resolve(spawnStub);
  } catch (err) {
    return Promise.reject(err);
  }
};

describe('Launcher', () => {
  beforeEach(() => {
    log.setLevel('error');
  });

  afterEach(() => {
    log.setLevel('');
  });

  it('sets default launching flags', async () => {
    const spawnStub = await launchChromeWithOpts({ userDataDir: 'some_path' });
    const chromeFlags = spawnStub.getCall(0).args[1] as string[];
    assert.ok(chromeFlags.find(f => f.startsWith('--remote-debugging-port')))
    assert.ok(chromeFlags.find(f => f.startsWith('--disable-background-networking')))
    assert.strictEqual(chromeFlags[chromeFlags.length - 1], 'about:blank');
  });

  it('accepts and uses a custom path', async () => {
    const fs = { ...fsMock, rm: spy() };
    const chromeInstance =
      new Launcher({ userDataDir: 'some_path' }, { fs: fs as any });

    await chromeInstance.prepare();

    await chromeInstance.destroyTmp();
    assert.strictEqual(fs.rm.callCount, 0);
  });

  it('allows to overwrite browser prefs', async () => {
    const existStub = stub().returns(true)
    const readFileStub = stub().returns(JSON.stringify({ some: 'prefs' }))
    const writeFileStub = stub()
    const mkdirStub = stub()
    const fs = { ...fsMock, readFile: readFileStub, writeFile: writeFileStub, mkdir: mkdirStub };
    const fse = { ...fseMock, pathExists: existStub }
    const chromeInstance =
      new Launcher({ prefs: { 'download.default_directory': '/some/dir' } }, { fs: fs as any, fse: fse as any });

    await chromeInstance.prepare();
    assert.strictEqual(
      writeFileStub.getCall(0).args[1],
      '{"some":"prefs","download.default_directory":"/some/dir"}'
    )
  });

  it('allows to set browser prefs', async () => {
    const existStub = stub().returns(false)
    const readFileStub = stub().returns(Buffer.from(JSON.stringify({ some: 'prefs' })))
    const writeFileStub = stub()
    const mkdirStub = stub()
    const fs = { ...fsMock, readFile: readFileStub, writeFile: writeFileStub, mkdir: mkdirStub };
    const fse = { ...fseMock, pathExists: existStub }
    const chromeInstance =
      new Launcher({ prefs: { 'download.default_directory': '/some/dir' } }, { fs: fs as any, fse: fse as any });

    await chromeInstance.prepare();
    assert.strictEqual(readFileStub.getCalls().length, 0)
    assert.strictEqual(
      writeFileStub.getCall(0).args[1],
      '{"download.default_directory":"/some/dir"}'
    )
  });

  it('cleans up the tmp dir after closing (mocked)', async () => {
    const rmMock = stub().callsFake((_path, _options) => { });
    const fs = { ...fsMock, rm: rmMock };

    const chromeInstance = new Launcher({}, { fs: fs as any });

    await chromeInstance.prepare();
    await chromeInstance.destroyTmp();
    assert.strictEqual(rmMock.callCount, 1);
  });

  it('cleans up the tmp dir after closing (real)', async () => {
    const rmSpy = spy(fs, 'rm');
    const pathExistsSpy = spy(fse, 'pathExists');
    const fsFake = { ...fsMock, rm: rmSpy };
    const fseFake = { ...fseMock, pathExists: pathExistsSpy };

    const chromeInstance = new Launcher({}, { fs: fsFake as any, fse: fseFake as any });

    await chromeInstance.launch();
    assert.ok(chromeInstance.userDataDir);
    assert.ok(await fse.pathExists(chromeInstance.userDataDir));

    await chromeInstance.kill();

    // tmpdir is gone 
    const [path] = fsFake.rm.getCall(0).args;
    assert.strictEqual(chromeInstance.userDataDir, path);
    assert.strictEqual(await fse.pathExists(path as string), false, `userdatadir still exists: ${path}`);
  }).timeout(30 * 1000);

  it('does not delete created directory when custom path passed', async () => {
    const chromeInstance = new Launcher({ userDataDir: 'some_path' }, { fs: fsMock as any });

    await chromeInstance.prepare();
    assert.strictEqual(chromeInstance.userDataDir, 'some_path');
  });

  it('defaults to genering a tmp dir when no data dir is passed', async () => {
    const chromeInstance = new Launcher({}, { fs: fsMock as any });
    const originalMakeTmp = chromeInstance.makeTmpDir;
    chromeInstance.makeTmpDir = () => 'tmp_dir'
    await chromeInstance.prepare()
    assert.strictEqual(chromeInstance.userDataDir, 'tmp_dir');

    // Restore the original fn.
    chromeInstance.makeTmpDir = originalMakeTmp;
  });

  it('doesn\'t fail when killed twice', async () => {
    const chromeInstance = new Launcher();
    await chromeInstance.launch();
    await chromeInstance.kill();
    await chromeInstance.kill();
  }).timeout(30 * 1000);

  it('doesn\'t fail when killing all instances', async () => {
    await launch();
    await launch();
    const errors = await killAll();
    assert.strictEqual(errors.length, 0);
  });

  it('doesn\'t launch multiple chrome processes', async () => {
    const chromeInstance = new Launcher();
    await chromeInstance.launch();
    let pid = chromeInstance.pid!;
    await chromeInstance.launch();
    assert.strictEqual(pid, chromeInstance.pid);
    await chromeInstance.kill();
  });

  it('gets all default flags', async () => {
    const flags = Launcher.defaultFlags();
    assert.ok(flags.length);
    assert.deepStrictEqual(flags, DEFAULT_FLAGS);
  });

  it('does not allow mutating default flags', async () => {
    const flags = Launcher.defaultFlags();
    flags.push('--new-flag');
    const currentDefaultFlags = Launcher.defaultFlags().slice();
    assert.notDeepStrictEqual(flags, currentDefaultFlags);
  });

  it('does not mutate default flags when launching', async () => {
    const originalDefaultFlags = Launcher.defaultFlags().slice();
    await launchChromeWithOpts();
    const currentDefaultFlags = Launcher.defaultFlags().slice();
    assert.deepStrictEqual(originalDefaultFlags, currentDefaultFlags);
  });

  it('removes all default flags', async () => {
    const spawnStub = await launchChromeWithOpts({ ignoreDefaultFlags: true });
    const chromeFlags = spawnStub.getCall(0).args[1] as string[];
    assert.ok(!chromeFlags.includes('--disable-extensions'));
  });

  it('searches for available installations', async () => {
    const installations = Launcher.getInstallations();
    assert.ok(Array.isArray(installations));
    assert.ok(installations.length >= 1);
  }).timeout(30_000);

  it('removes --user-data-dir if userDataDir is false', async () => {
    const spawnStub = await launchChromeWithOpts();
    const chromeFlags = spawnStub.getCall(0).args[1] as string[];
    assert.ok(!chromeFlags.includes('--user-data-dir'));
  });

  it('passes no env vars when none are passed', async () => {
    const spawnStub = await launchChromeWithOpts();
    const spawnOptions = spawnStub.getCall(0).args[2] as { env: {} };
    assert.deepStrictEqual(spawnOptions.env, Object.assign({}, process.env));
  });

  it('passes env vars when passed', async () => {
    const envVars = { 'hello': 'world' };
    const spawnStub = await launchChromeWithOpts({ envVars });
    const spawnOptions = spawnStub.getCall(0).args[2] as { env: {} };
    assert.deepStrictEqual(spawnOptions.env, envVars);
  });

  it('ensure specific flags are present when passed and defaults are ignored', async () => {
    const spawnStub = await launchChromeWithOpts({
      ignoreDefaultFlags: true,
      chromeFlags: ['--disable-extensions', '--mute-audio', '--no-first-run']
    });
    const chromeFlags = spawnStub.getCall(0).args[1] as string[];
    assert.ok(chromeFlags.includes('--mute-audio'));
    assert.ok(chromeFlags.includes('--disable-extensions'));

    // Make sure that default flags are not present
    assert.ok(!chromeFlags.includes('--disable-background-networking'));
    assert.ok(!chromeFlags.includes('--disable-default-app'));
  });

  it('throws an error when chromePath is empty', (done) => {
    const chromeInstance = new Launcher({ chromePath: '' });
    chromeInstance.launch().catch(() => done());
  });

  describe('getChromePath', async () => {
    it('returns the same path as a full Launcher launch', async () => {
      const spawnStub = await launchChromeWithOpts();
      const launchedPath = spawnStub.getCall(0).args[0] as string;

      const chromePath = getChromePath();
      assert.strictEqual(chromePath, launchedPath);
    });
  });
});
