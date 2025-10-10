import { execCommand, retry } from "../utils";

export type AndroidABI = 
  | 'all'
  | 'x86_64'
  | 'aarch64'
  | 'armv7'
  | 'i686';

export type AndroidHostOs = 'windows_x64' | 'macos_x64' | 'macos_aarch64' | 'linux_x64';

// 'default' is the standard Android build variant, 'quest' is for Oculus Quest (now Meta Quest) VR devices
export type AndroidVariant = 'default' | 'quest';

export interface AndroidBuildOptions {
  abi: AndroidABI;
  package_name: string;
  app_label: string;
  sdk_path?: string;
  full_ndk?: boolean; // Install the full NDK prebuilts for the selected host OS (default installs a minimal subset). Required for apps compiling native code in Rust.
  keep_sdk_sources?: boolean; // Keep downloaded SDK source files (default is to remove them).
  host_os?: AndroidHostOs;
  variant?: AndroidVariant;
}

export async function installAndroidBuildDependencies(abi: AndroidABI) {
  console.log(`🔧 Installing Android build dependencies for ABI: ${abi}...`);
  let installed = false;

  await retry(async () => {
    const { matched } = await execCommand(
        'cargo',
        ['makepad', 'android', `--abi=${abi}`, 'install-toolchain'],
        {
          captureOutput: true,
          keyword: 'Android toolchain has been installed',
        }
      );

      if (matched) {
        installed = true;
        console.log('🎉 Android toolchain installation verified successfully.');
      } else {
        throw new Error('Android toolchain installation verification failed. Will retry...');
      }
    }, 3, 5000, (attempt, err) => {
      console.warn(`❌ Attempt ${attempt} to install Android build dependencies failed:`, err);
      console.log('⏳ Retrying...');
    }
  );

  if (!installed) {
    throw new Error('❌ Android toolchain installation did not complete successfully after retries.');
  }

  console.log(`✅ Android build dependencies for ABI '${abi}' are installed and verified.`);
}