/**
 * The Android network security configuration for the app, as data.
 *
 * Kept free of any `expo` import so the root test suite can pin it
 * (tests/mobile-network-security-config.test.ts): root CI never installs this
 * package's dependencies. The config plugin beside this file does the writing.
 *
 * What the file says, and why:
 *
 * - `<certificates src="user" />`: since Android 7 an app trusts only the
 *   system certificate store unless it opts in. A Filament DB desktop or
 *   server that shares through its secure gateway serves, by default, a
 *   certificate issued by a certificate authority it generated itself, which
 *   the owner installs on the phone (Settings → Security → Install a
 *   certificate → CA certificate). Without this line the app refused that
 *   certificate even after the owner had installed the CA.
 * - `<certificates src="system" />`: a certificate from a public CA keeps
 *   working. Naming trust anchors REPLACES the default set, so the system
 *   store has to be listed too.
 * - `cleartextTrafficPermitted="true"`: a desktop older than the secure
 *   gateway is reached at `http://<ip>:3456`. Once a network security config
 *   exists it, not the manifest's `android:usesCleartextTraffic`, decides
 *   this on Android 7+, and its own default is "no cleartext" for an app
 *   targeting Android 9 or later.
 *
 * What it does NOT do: it does not accept self-signed or unknown
 * certificates and it does not turn off host-name checking. A certificate is
 * accepted only if it chains to a CA on the device, and a CA gets into the
 * user store only through the phone's settings (behind the screen lock) or a
 * device-management policy. The trade-off is a browser's: whoever can install
 * a CA on the phone can read this app's traffic to the server.
 */

const NETWORK_SECURITY_CONFIG_RESOURCE = 'network_security_config';

const NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;

/**
 * Point the manifest's `<application>` at the config. Takes and returns the
 * parsed `<application>` element (xml2js shape: attributes under `$`).
 */
function applyNetworkSecurityConfig(application) {
  application.$ = application.$ || {};
  application.$['android:networkSecurityConfig'] = `@xml/${NETWORK_SECURITY_CONFIG_RESOURCE}`;
  return application;
}

module.exports = {
  NETWORK_SECURITY_CONFIG_RESOURCE,
  NETWORK_SECURITY_CONFIG_XML,
  applyNetworkSecurityConfig,
};
