import {ChildProcess, spawnSync} from 'child_process';
import * as fs from 'fs';
import * as glob from 'glob';
import * as ini from 'ini';
import * as os from 'os';
import * as path from 'path';
import * as q from 'q';

import {Logger} from '../cli';
import {spawn} from '../utils';


const noop = () => {};

// Make a function which configures a child process to automatically respond
// to a certain question
function respondFactory(question: string, answer: string): Function {
  return (child: ChildProcess) => {
    (<any>child.stdin).setDefaultEncoding('utf-8');
    child.stdout.on('data', (data: Buffer | String) => {
      if (data != null) {
        if (data.toString().indexOf(question) != -1) {
          child.stdin.write(answer + '\n');
        }
      }
    });
  };
}

// Run a command on the android SDK
function runAndroidSDKCommand(
    sdkPath: string, cmd: string, args: string[], stdio?: string,
    config_fun?: Function): q.Promise<any> {
  let child = spawn(path.join(sdkPath, 'tools', 'android'), [cmd].concat(args), stdio);

  if (config_fun) {
    config_fun(child);
  };

  let deferred = q.defer()
  child.on('exit', (code: number) => {
    if (deferred != null) {
      if (code) {
        deferred.reject(code);
      } else {
        deferred.resolve();
      }
      deferred = null;
    }
  });
  child.on('error', (err: Error) => {
    if (deferred != null) {
      deferred.reject(err);
      deferred = null;
    }
  });
  return deferred.promise;
}

// Download updates via the android SDK
function downloadAndroidUpdates(
    sdkPath: string, targets: string[], search_all: boolean, auto_accept: boolean): q.Promise<any> {
  return runAndroidSDKCommand(
      sdkPath, 'update',
      ['sdk', '-u'].concat(search_all ? ['-a'] : []).concat(['-t', targets.join(',')]),
      auto_accept ? 'pipe' : 'inherit',
      auto_accept ? respondFactory('Do you accept the license', 'y') : noop);
}

// Setup hardware acceleration for x86-64 emulation
function setupHardwareAcceleration(sdkPath: string) {
  // TODO(sjelin): check that the BIOS option is set properly on linux
  if (os.type() == 'Darwin') {
    console.log('Enabling hardware acceleration (requires root access)');
    // We don't need the wrapped spawnSync because we know we're on OSX
    spawnSync(
        'sudo', [path.join(
                    sdkPath, 'extras', 'intel', 'Hardware_Accelerated_Execution_Manager',
                    'silent_install.sh')],
        {stdio: 'inherit'});
  } else if (os.type() == 'Windows_NT') {
    console.log('Enabling hardware acceleration (requires admin access)');
    // We don't need the wrapped spawnSync because we know we're on Windows
    spawnSync(
        'cmd',
        [
          '/c', 'runas', '/noprofile', '/user:Administrator',
          path.join(
              sdkPath, 'extras', 'intel', 'Hardware_Accelerated_Execution_Manager',
              'silent_install.bat')
        ],
        {stdio: 'inherit'});
  }
}

// Get a list of all the SDK download targets for a given set of APIs,
// architectures, and platforms
function getAndroidSDKTargets(
    apiLevels: string[], architectures: string[], platforms: string[],
    oldAVDs: string[]): string[] {
  function getSysImgTarget(architecture: string, platform: string, level: string) {
    if (platform.toUpperCase() == 'DEFAULT') {
      platform = 'android';
    }
    return 'sys-img-' + architecture + '-' + platform + '-' + level;
  }

  let targets = apiLevels
                    .map((level) => {
                      return 'android-' + level;
                    })
                    .concat(architectures.reduce((targets, architecture) => {
                      return targets.concat.apply(targets, platforms.map((platform) => {
                        return apiLevels.map(getSysImgTarget.bind(null, architecture, platform));
                      }));
                    }, []));

  oldAVDs.forEach((name) => {
    let avd = new AVDDescriptor(name);
    if (targets.indexOf(avd.api) == -1) {
      targets.push(avd.api);
    }
    let sysImgTarget =
        getSysImgTarget(avd.architecture, avd.platform, avd.api.slice('android-'.length));
    if (targets.indexOf(sysImgTarget) == -1) {
      targets.push(sysImgTarget);
    }
  });

  return targets;
}

// All the information about an android virtual device
class AVDDescriptor {
  api: string;
  platform: string;
  architecture: string;
  abi: string;
  name: string;

  constructor(api: string, platform?: string, architecture?: string) {
    if (platform != undefined) {
      this.api = api;
      this.platform = platform;
      this.architecture = architecture;
      this.name = [api, platform, architecture].join('-');
    } else {
      this.name = api;
      let nameParts = this.name.split('-');
      this.api = nameParts[0] + '-' + nameParts[1];
      if (/v[0-9]+[a-z]+/.test(nameParts[nameParts.length - 1]) &&
          (nameParts[nameParts.length - 2].slice(0, 3) == 'arm')) {
        this.architecture = nameParts[nameParts.length - 2] + '-' + nameParts[nameParts.length - 1];
      } else {
        this.architecture = nameParts[nameParts.length - 1];
      }
      this.platform = this.name.slice(this.api.length + 1, -this.architecture.length - 1);
    }
    this.abi =
        (this.platform.toUpperCase() == 'DEFAULT' ? '' : this.platform + '/') + this.architecture;
  }

  avdName(version: string): string {
    return this.name + '-v' + version + '-wd-manager';
  }
}

// Gets the descriptors for all AVDs which are possible to make given the
// SDKs which were downloaded
function getAVDDescriptors(sdkPath: string): q.Promise<AVDDescriptor[]> {
  let deferred = q.defer<AVDDescriptor[]>();
  glob(path.join(sdkPath, 'system-images', '*', '*', '*'), (err: Error, files: string[]) => {
    if (err) {
      deferred.reject(err);
    } else {
      deferred.resolve(files.map((file: string) => {
        let info = file.split(path.sep).slice(-3);
        return new AVDDescriptor(info[0], info[1], info[2]);
      }));
    }
  });
  return deferred.promise;
}

function sequentialForEach<T>(array: T[], func: (x: T) => q.Promise<any>): q.Promise<any> {
  let ret = q(null);

  array.forEach((x: T) => {
    ret = ret.then(() => {
      return func(x);
    });
  });

  return ret;
}

// Configures the hardware.ini file for a system image of a new AVD
function configureAVDHardware(sdkPath: string, desc: AVDDescriptor): q.Promise<any> {
  let file = path.join(
      sdkPath, 'system-images', desc.api, desc.platform, desc.architecture, 'hardware.ini');
  return q.nfcall(fs.stat, file)
      .then(
          (stats: fs.Stats) => {
            return q.nfcall(fs.readFile, file);
          },
          (err: Error) => {
            return q('');
          })
      .then((contents: string | Buffer) => {
        let config: any = ini.parse(contents.toString());
        config['hw.keyboard'] = 'yes';
        config['hw.battery'] = 'yes';
        config['hw.ramSize'] = 1024;
        return q.nfcall(fs.writeFile, file, ini.stringify(config));
      });
}

// Make an android virtual device
function makeAVD(sdkPath: string, desc: AVDDescriptor, version: string): q.Promise<any> {
  return runAndroidSDKCommand(sdkPath, 'delete', ['avd', '--name', desc.avdName(version)])
      .then(noop, noop)
      .then(() => {
        return runAndroidSDKCommand(
            sdkPath, 'create',
            ['avd', '--name', desc.avdName(version), '--target', desc.api, '--abi', desc.abi],
            'pipe', respondFactory('Do you wish to create a custom hardware profile', 'no'));
      });
}

// Initialize the android SDK
export function android(
    sdkPath: string, apiLevels: string[], architectures: string[], platforms: string[],
    acceptLicenses: boolean, version: string, oldAVDs: string[], logger: Logger): void {
  let avdDescriptors: AVDDescriptor[];
  let tools = ['platform-tool', 'tool'];
  if ((os.type() == 'Darwin') || (os.type() == 'Windows_NT')) {
    tools.push('extra-intel-Hardware_Accelerated_Execution_Manager');
  }

  logger.info('android-sdk: Downloading additional SDK updates');
  downloadAndroidUpdates(sdkPath, tools, false, acceptLicenses)
      .then(() => {
        return setupHardwareAcceleration(sdkPath);
      })
      .then(() => {
        logger.info(
            'android-sdk: Downloading more additional SDK updates ' +
            '(this may take a while)');
        return downloadAndroidUpdates(
            sdkPath, ['build-tools-24.0.0'].concat(
                         getAndroidSDKTargets(apiLevels, architectures, platforms, oldAVDs)),
            true, acceptLicenses);
      })
      .then(() => {
        return getAVDDescriptors(sdkPath);
      })
      .then((descriptors: AVDDescriptor[]) => {
        avdDescriptors = descriptors;
        logger.info('android-sdk: Configuring virtual device hardware');
        return sequentialForEach(avdDescriptors, (descriptor: AVDDescriptor) => {
          return configureAVDHardware(sdkPath, descriptor);
        });
      })
      .then(() => {
        return sequentialForEach(avdDescriptors, (descriptor: AVDDescriptor) => {
          logger.info('android-sdk: Setting up virtual device "' + descriptor.name + '"');
          return makeAVD(sdkPath, descriptor, version);
        });
      })
      .then(() => {
        return q.nfcall(
            fs.writeFile, path.join(sdkPath, 'available_avds.json'),
            JSON.stringify(avdDescriptors.map((descriptor: AVDDescriptor) => {
              return descriptor.name;
            })));
      })
      .then(() => {
        logger.info('android-sdk: Initialization complete');
      })
      .done();
};

export function iOS(logger: Logger) {
  if (os.type() != 'Darwin') {
    throw new Error('Must be on a Mac to simulate iOS devices.');
  }
  try {
    fs.statSync('/Applications/Xcode.app');
  } catch (e) {
    logger.warn('You must install the xcode commandline tools!');
  }
}
