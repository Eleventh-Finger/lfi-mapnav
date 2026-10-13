# LFI Map Navigator

LFI Map Navigator is a manual & automated LFI navigator that can create a map of any directories and files you have visited or seen.

Note: This extension, python host and python host installer may only be used against systems you own or are explicitly authorised to test.

## Included files

- `extension/` — Firefox extension files, including its manifest, popup, background script, styles, and font (HostGrotesk).
- `native/lfi_navigator_host.py` — Python 3 HTTP transport launched by Firefox.
- `native/install_linux.sh` — Registers the native host with Firefox for the current user.

## Requirements

- Linux
- Firefox
- Python 3 available as `python3`

## Installation Guide

1. Extract the entire ZIP archive.
2. Open a terminal in the extracted `native` directory.
3. Run:

   ```sh
   chmod +x install_linux.sh
   ./install_linux.sh
   ```

4. Load the extension by navigating to `about:debugging#/runtime/this-firefox` in firefox, choose **Load Temporary Add-on**, and select `extension/manifest.json` from the extracted directory. Temporary add-ons will need to be loaded again anytime Firefox restarts.


   Note: The installer copies the host to `~/.local/share/lfi-navigator-native/` and registers it under `~/.mozilla/native-messaging-hosts/`. It does not require root privileges. If your Firefox distribution uses a different profile or native-messaging registration location    (for example, some sandboxed packages), you may need to adapt the installer for that setup.
## How to use

1. Open LFI Map Navigator by selecting the added extension in firefox.
2. Set the root URL for the authorised target.
3. Enable scoped fetching.
4. Enter a path and use the arrow to send the request. Alternatively, navigate to each page and lfi-mapnav will map out directories and files automatically (Using GET).
5. Choose GET, POST, or PUT. POST and PUT can send the request-body field using the selected Content-Type.
6. Map memory can be cleared and exported.

The extension enforces its configured URL scope before sending requests. Browser navigation tracking and **Fetch current page** use GET. Use only against systems you own or are explicitly authorised to test.

## Troubleshooting

- Confirm `python3 --version` works in the terminal.
- Re-run `./install_linux.sh` if you move the extracted folder or want to refresh the native host registration.
- If Firefox reports that the native host cannot be found, check that `~/.local/share/lfi-navigator-native/lfi_navigator_host.py` exists and is executable, and that `~/.mozilla/native-messaging-hosts/lfi_navigator_transport.json` exists.
- Confirm the extension ID in `extension/manifest.json` matches the native manifest's `allowed_extensions` entry: `lfi-navigator@ctf-lab.local`.

## Release

LFI Map Navigator 1.0.0B is the first official release. This bundle contains the Firefox extension runtime files, required Python native host, Linux installer, and this README.

## Future Goals
Fixing expand and collapse buttons, and a working JSON map file import. 
