import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.dirname(toolsRoot);

async function bundleSource(relativePath) {
    return readFile(
        path.join(bundleRoot, ...relativePath.split('/')),
        'utf8'
    );
}

function testConsole() {
    return {
        error: function error() {},
        log: function log() {},
        warn: function warn() {}
    };
}

async function installFrontend(window) {
    const source = await bundleSource('src/frontend/shared/arcane-api.js');
    vm.runInNewContext(
        source,
        {
            clearTimeout,
            console: testConsole(),
            setTimeout,
            window
        },
        {
            filename: 'arcane-api.js'
        }
    );
    return window.Arcane;
}

function responseFor(request, result) {
    return JSON.stringify(
        {
            id: request.id,
            ok: true,
            protocol: 'arcane/1',
            result,
            type: 'response'
        }
    );
}

test('Android transport forwards request JSON and receives responses and events', async function testAndroidTransportRoundTrip() {
    const sent = [];
    const bridge = {
        onmessage: null,
        postMessage: function postMessage(json) {
            sent.push(json);
        }
    };
    const window = {
        arcaneAndroid: bridge,
        crypto: {
            randomUUID: function randomUUID() {
                return 'android-request-1';
            }
        }
    };
    const arcane = await installFrontend(window);
    const observedEvents = [];
    arcane.events.on(
        'launcher.status',
        function onLauncherStatus(value) {
            observedEvents.push(value);
        }
    );

    const pending = arcane.platform.status();
    assert.equal(sent.length, 1);
    const request = JSON.parse(sent[0]);
    assert.equal(request.protocol, 'arcane/1');
    assert.equal(request.type, 'request');
    assert.equal(request.id, 'android-request-1');
    assert.equal(request.method, 'platform.status');
    assert.deepEqual(request.parameters, {});

    bridge.onmessage(
        {
            data: JSON.stringify(
                {
                    data: {
                        ready: true
                    },
                    event: 'launcher.status',
                    protocol: 'arcane/1',
                    type: 'event'
                }
            )
        }
    );
    bridge.onmessage(
        responseFor(
            request,
            {
                nativeAdapter: 'android'
            }
        )
    );

    const roundTripResult = JSON.parse(JSON.stringify(await pending));
    const roundTripExpected = {
        nativeAdapter: 'android'
    };
    const normalizedEvents = JSON.parse(JSON.stringify(observedEvents));
    const expectedEvents = [
        {
            ready: true
        }
    ];
    assert.deepEqual(roundTripResult, roundTripExpected);
    assert.deepEqual(normalizedEvents, expectedEvents);
});

test('desktop native transports retain precedence over Android', async function testTransportPrecedence() {
    const sends = [];
    const window = {
        arcaneAndroid: {
            postMessage: function postMessage() {
                sends.push('android');
            }
        },
        chrome: {
            webview: {
                addEventListener: function addEventListener() {},
                hostObjects: {
                    arcaneBridge: {
                        Send: function Send(json) {
                            sends.push('webview2');
                            const request = JSON.parse(json);
                            const result = {
                                nativeAdapter: 'windows'
                            };
                            const response = responseFor(request, result);
                            window.__arcaneReceive(response);
                        }
                    }
                }
            }
        },
        crypto: {
            randomUUID: function randomUUID() {
                return 'precedence-request-1';
            }
        },
        webkit: {
            messageHandlers: {
                arcane: {
                    postMessage: function postMessage() {
                        sends.push('webkitgtk');
                    }
                }
            }
        }
    };
    const arcane = await installFrontend(window);
    const result = await arcane.platform.status();

    const expectedSends = [
        'webview2'
    ];
    assert.deepEqual(sends, expectedSends);
    assert.equal(result.nativeAdapter, 'windows');
});

test('Android transport takes precedence over development HTTP', async function testAndroidBeforeDevelopmentTransport() {
    let fetchCalled = false;
    let sentRequest = null;
    const bridge = {
        postMessage: function postMessage(json) {
            sentRequest = JSON.parse(json);
            const result = {
                nativeAdapter: 'android'
            };
            const response = responseFor(sentRequest, result);
            window.__arcaneReceive(response);
        }
    };
    const window = {
        __ARCANE_DEV_HTTP__: true,
        arcaneAndroid: bridge,
        crypto: {
            randomUUID: function randomUUID() {
                return 'precedence-request-2';
            }
        }
    };
    const source = await bundleSource('src/frontend/shared/arcane-api.js');
    vm.runInNewContext(
        source,
        {
            clearTimeout,
            console: testConsole(),
            fetch: function fetch() {
                fetchCalled = true;
                throw new Error('Development HTTP must not run when the Android bridge is present.');
            },
            setTimeout,
            window
        },
        {
            filename: 'arcane-api.js'
        }
    );

    const result = await window.Arcane.platform.status();
    assert.equal(sentRequest.method, 'platform.status');
    assert.equal(result.nativeAdapter, 'android');
    assert.equal(fetchCalled, false);
});

test('absent and malformed Android bridges fail closed', async function testUnavailableAndroidBridge() {
    const absentWindow = {
        crypto: {
            randomUUID: function randomUUID() {
                return 'absent-request';
            }
        }
    };
    const malformedWindow = {
        arcaneAndroid: {
            postMessage: 'not-a-function'
        },
        crypto: {
            randomUUID: function randomUUID() {
                return 'malformed-request';
            }
        }
    };
    const absent = await installFrontend(absentWindow);
    const malformed = await installFrontend(malformedWindow);

    await assert.rejects(
        absent.platform.status(),
        function isUnavailable(error) {
            return error && error.code === 'ARCANE_TRANSPORT_UNAVAILABLE';
        }
    );
    await assert.rejects(
        malformed.platform.status(),
        function isMalformedUnavailable(error) {
            return error && error.code === 'ARCANE_TRANSPORT_UNAVAILABLE';
        }
    );
});

test('Android bridge call failures are normalized without falling back', async function testAndroidBridgeCallFailure() {
    const window = {
        arcaneAndroid: {
            postMessage: function postMessage() {
                throw new TypeError('host bridge unavailable');
            }
        },
        crypto: {
            randomUUID: function randomUUID() {
                return 'failed-request';
            }
        }
    };
    const arcane = await installFrontend(window);

    await assert.rejects(
        arcane.platform.status(),
        function isAndroidBridgeFailure(error) {
            return error
                && error.code === 'ARCANE_ANDROID_BRIDGE_CALL_FAILED'
                && error.transport === 'android-webview'
                && error.method === 'platform.status';
        }
    );
});

test('Kotlin host binds the Android bridge to one exact trusted main-frame origin', async function testKotlinOriginContract() {
    const source = await bundleSource('src/hosts/android/ArcaneWebViewBridge.kt');

    assert.match(source, /const val TRUSTED_ORIGIN = "https:\/\/appassets\.androidplatform\.net"/);
    assert.match(source, /const val BRIDGE_NAME = "arcaneAndroid"/);
    assert.match(
        source,
        /WebViewCompat\.addWebMessageListener\(\s*webView,\s*BRIDGE_NAME,\s*setOf\(TRUSTED_ORIGIN\),\s*listener\s*\)/
    );
    assert.match(source, /if \(!isMainFrame \|\| !isTrustedOrigin\(sourceOrigin\)\)/);
    assert.match(source, /origin\.scheme == "https"/);
    assert.match(source, /origin\.host == "appassets\.androidplatform\.net"/);
    assert.match(source, /origin\.port == -1/);
    assert.match(source, /origin\.userInfo == null/);
    assert.doesNotMatch(source, /setOf\([^)]*"\*"/);
});

test('Kotlin host bounds requests and allows only reviewed Android methods', async function testKotlinRequestContract() {
    const bridgeSource = await bundleSource('src/hosts/android/ArcaneWebViewBridge.kt');
    const protocolSource = await bundleSource('src/hosts/android/AndroidBridgeProtocol.kt');
    const registrySource = await bundleSource('src/hosts/android/GeneratedAndroidCapabilityRegistry.kt');

    assert.match(protocolSource, /private const val MAX_MESSAGE_BYTES = 1024 \* 1024/);
    assert.match(bridgeSource, /WebViewFeature\.isFeatureSupported\(WebViewFeature\.WEB_MESSAGE_LISTENER\)/);
    assert.match(bridgeSource, /message\.type != WebMessageCompat\.TYPE_STRING/);
    assert.match(bridgeSource, /val encoded = message\.data/);
    assert.match(bridgeSource, /if \(encoded == null\)/);
    assert.match(bridgeSource, /AndroidBridgeProtocol\.isOversized\(encoded\)/);
    assert.match(protocolSource, /toByteArray\(StandardCharsets\.UTF_8\)\.size > MAX_MESSAGE_BYTES/);
    assert.match(registrySource, /PLATFORM_STATUS_METHOD = "platform\.status"/);
    assert.match(registrySource, /PLATFORM_STATUS_CAPABILITY = "system\.read"/);
    assert.match(registrySource, /EXTERNAL_OPEN_METHOD = "external\.open"/);
    assert.match(registrySource, /EXTERNAL_OPEN_CAPABILITY = "external\.open"/);
    assert.match(registrySource, /NETWORK_STATUS_METHOD = "network\.status"/);
    assert.match(registrySource, /NETWORK_STATUS_CAPABILITY = "network\.status\.read"/);
    assert.match(registrySource, /internal fun capabilityFor\(method: String\): String\?/);
    assert.match(registrySource, /internal fun isSupported\(method: String\): Boolean/);
    assert.match(bridgeSource, /GeneratedAndroidCapabilityRegistry\.isSupported\(request\.method\)/);
    assert.match(protocolSource, /"ANDROID_CAPABILITY_UNSUPPORTED"/);
    assert.match(
        protocolSource,
        /hasExactKeys\(request, setOf\("protocol", "type", "id", "method", "parameters", "sentAt"\)\)/
    );
    assert.match(protocolSource, /val protocol = request\.opt\("protocol"\) as\? String \?: return null/);
    assert.match(protocolSource, /val type = request\.opt\("type"\) as\? String \?: return null/);
    assert.match(protocolSource, /val id = request\.opt\("id"\) as\? String \?: return null/);
    assert.match(protocolSource, /val method = request\.opt\("method"\) as\? String \?: return null/);
    assert.match(protocolSource, /val sentAt = request\.opt\("sentAt"\) as\? String \?: return null/);
    assert.match(protocolSource, /val parameters = request\.opt\("parameters"\) as\? JSONObject \?: return null/);
    assert.match(protocolSource, /requestIdPattern = Regex\("\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,127\}\$"\)/);
    assert.match(protocolSource, /method\.isEmpty\(\) \|\| method\.length > 128/);
    assert.match(protocolSource, /sentAtPattern\.matches\(sentAt\)/);
    assert.doesNotMatch(protocolSource, /request\.optString\("(?:protocol|type|id|method|sentAt)"/);
    assert.match(protocolSource, /method == GeneratedAndroidCapabilityRegistry\.PLATFORM_STATUS_METHOD/);
    assert.match(protocolSource, /method == GeneratedAndroidCapabilityRegistry\.EXTERNAL_OPEN_METHOD/);
    assert.match(protocolSource, /hasExactKeys\(parameters, setOf\("uri"\)\)/);
    assert.match(bridgeSource, /fun interface CapabilityGrantProvider/);
    assert.match(bridgeSource, /val grantedCapabilities = readGrantedCapabilities\(\)/);
    const methodCheck = bridgeSource.indexOf('GeneratedAndroidCapabilityRegistry.isSupported(request.method)');
    const grantCheck = bridgeSource.indexOf('val grantedCapabilities = readGrantedCapabilities()');
    const replayCheck = bridgeSource.indexOf('replayWindow.remember(request.id)', grantCheck);
    const statusRead = bridgeSource.indexOf('platformStatusProvider.currentStatus()');
    const externalOpen = bridgeSource.indexOf('externalOpenProvider.openMailto(canonicalUri)');
    assert(methodCheck >= 0 && grantCheck > methodCheck && replayCheck > grantCheck && statusRead > replayCheck && externalOpen > statusRead, 'Android must authorize method and grant, bind identity, and admit replay before host provider work.');
    assert.match(bridgeSource, /"ANDROID_CAPABILITY_DENIED"/);
    assert.match(protocolSource, /\.put\("level", "application-sandbox"\)/);
    assert.match(protocolSource, /\.put\(\s*"capabilities",\s*JSONObject\(\)/);
    assert.match(protocolSource, /JSONArray\(grants\)/);
    assert.match(protocolSource, /JSONArray\(methods\)/);
    assert.doesNotMatch(protocolSource, /when\s*\(request\.method\)/);
});

test('Kotlin host rejects duplicate request identifiers with bounded memory', async function testKotlinDuplicateRequestContract() {
    const bridgeSource = await bundleSource('src/hosts/android/ArcaneWebViewBridge.kt');
    const protocolSource = await bundleSource('src/hosts/android/AndroidBridgeProtocol.kt');

    assert.match(protocolSource, /private const val MAX_REMEMBERED_REQUEST_IDS = 4096/);
    assert.match(protocolSource, /internal class ReplayWindow/);
    assert.match(protocolSource, /private val requestIds = LinkedHashSet<String>\(\)/);
    assert.match(protocolSource, /if \(!requestIds\.add\(requestId\)\)/);
    assert.match(protocolSource, /requestIds\.size > MAX_REMEMBERED_REQUEST_IDS/);
    assert.match(protocolSource, /requestIds\.remove\(requestIds\.first\(\)\)/);
    assert.match(bridgeSource, /private val replayWindow = AndroidBridgeProtocol\.ReplayWindow\(\)/);
    assert.match(bridgeSource, /"ANDROID_BRIDGE_DUPLICATE_REQUEST"/);
});

test('Kotlin protocol core bounds status fields and response schema', async function testKotlinResponseContract() {
    const source = await bundleSource('src/hosts/android/AndroidBridgeProtocol.kt');
    const contracts = await bundleSource('src/hosts/android/GeneratedAndroidMethodContracts.kt');

    assert.match(source, /internal object AndroidBridgeProtocol/);
    assert.match(contracts, /PLATFORM_STATUS_OUTPUT_MAX_STATUS_STRING_LENGTH = 256/);
    for (const field of ['release', 'architecture', 'version']) {
        assert.match(source, new RegExp(`\\.put\\("${field}", status\\.${field}\\)`));
    }
    assert.match(source, /isValidStatusText\(status\.release\)/);
    assert.match(source, /status\.version != application\.version/);
    assert.match(source, /METHOD_CONTRACT_OUTPUT_INVALID/);
    assert.match(source, /\.put\("application", application\.id\)/);
    assert.match(source, /status\.rendererVersion \?: JSONObject\.NULL/);
    assert.match(source, /\.put\("protocol", PROTOCOL\)/);
    assert.match(source, /\.put\("type", "response"\)/);
    assert.match(source, /\.put\("id", requestId\)/);
    assert.match(source, /\.put\("ok", true\)/);
    assert.match(source, /\.put\("ok", false\)/);
    assert.match(source, /\.put\("securityMode", "unverified"\)/);
    assert.match(source, /\.put\("publisherTrustSource", JSONObject\.NULL\)/);
    assert.match(source, /\.put\("displayName", application\.displayName\)/);
    assert.match(source, /\.put\("type", application\.type\)/);
    assert.match(source, /\.put\("entry", application\.entry \?: JSONObject\.NULL\)/);
    assert.match(source, /private fun validatedApplication\(application: Application\): Application\?/);
    assert.match(source, /applicationIdPattern\.matches\(application\.id\)/);
    assert.match(source, /application\.type !in setOf\("app", "shell", "provisioner"\)/);
    assert.match(source, /for \(segment in entry\.split\('\/'\)\)/);
    assert.match(source, /segment == "\." \|\| segment == "\.\." \|\| segment\.isEmpty\(\)/);
    for (const field of ['hostPlatform', 'effectivePlatform', 'simulation', 'evidenceClass']) {
        assert.match(source, new RegExp(`\\.put\\("${field}"`));
    }
    for (const field of ['desktop', 'sessionType', 'simulated']) {
        assert.match(source, new RegExp(`\\.put\\("${field}"`));
    }
});

test('Kotlin host accepts an explicit application descriptor', async function testKotlinApplicationDescriptor() {
    const source = await bundleSource('src/hosts/android/ArcaneWebViewBridge.kt');

    assert.match(source, /data class ApplicationDescriptor\(/);
    for (const field of ['id', 'displayName', 'type', 'entry', 'version']) {
        assert.match(source, new RegExp(`val ${field}:`));
    }
    assert.match(source, /val application: ApplicationDescriptor/);
    assert.match(source, /application = AndroidBridgeProtocol\.Application\(/);
    assert.match(source, /private val expectedApplicationEntry: String/);
    assert.match(source, /status\.application\.entry != expectedApplicationEntry/);
    assert.match(source, /"ANDROID_APPLICATION_IDENTITY_MISMATCH"/);
});

test('Android host session binds validated identity, exact grants, and platform facts', async function testAndroidHostSession() {
    const sessionSource = await bundleSource('src/hosts/android/ArcaneAndroidHostSession.kt');
    const controllerSource = await bundleSource('src/hosts/android/ArcaneWebViewHostController.kt');

    const applicationRegistry = await bundleSource('src/hosts/android/GeneratedAndroidApplicationRegistry.kt');
    assert.match(sessionSource, /internal class ArcaneAndroidHostSession private constructor\(/);
    assert.match(sessionSource, /ArcaneWebViewBridge\.CapabilityGrantProvider/);
    assert.match(sessionSource, /ArcaneWebViewBridge\.PlatformStatusProvider/);
    assert.match(sessionSource, /ArcaneWebViewBridge\.ApplicationIdentityProvider/);
    assert.match(sessionSource, /private val packageVersion = currentPackageVersion\(applicationContext\)/);
    assert.match(sessionSource, /private val applicationDescriptor = validatedApplication\(packageVersion\)/);
    assert.match(sessionSource, /GeneratedAndroidApplicationRegistry\.shellGrants\(\)\.toSet\(\)/);
    assert.match(sessionSource, /private val status = ArcaneWebViewBridge\.PlatformStatus\(/);
    assert.match(sessionSource, /AndroidBridgeProtocol\.isValidApplication\(protocolApplication\)/);
    assert.match(sessionSource, /internal fun createShell\(context: Context\): ArcaneAndroidHostSession/);
    assert.match(sessionSource, /GeneratedAndroidApplicationRegistry\.SHELL_ID/);
    assert.match(sessionSource, /GeneratedAndroidApplicationRegistry\.SHELL_ENTRY/);
    assert.match(applicationRegistry, /internal fun shellGrants\(\): Set<String>/);
    assert.match(applicationRegistry, /BUNDLE_VERSION = "0\.8\.4"/);
    assert.match(applicationRegistry, /return Collections\.unmodifiableSet\(grants\)/);
    assert.doesNotMatch(applicationRegistry, /internal val shellGrants/);
    assert.doesNotMatch(applicationRegistry, /EXTERNAL_OPEN_CAPABILITY/);
    assert.match(sessionSource, /return grants\.contains\(capability\)/);
    assert.match(sessionSource, /return status/);
    assert.match(sessionSource, /release = validatedStatus\(Build\.VERSION\.RELEASE, "Android release"\)/);
    assert.match(sessionSource, /for \(architecture in Build\.SUPPORTED_ABIS\)/);
    assert.match(sessionSource, /context\.packageManager\.getPackageInfo\(context\.packageName, 0\)/);
    assert.match(sessionSource, /version = packageVersion/);
    assert.match(sessionSource, /rendererVersion = null/);
    assert.match(sessionSource, /value\.length > Limits\.MAX_STATUS_LENGTH/);
    assert.match(sessionSource, /character\.code <= 31 \|\| character\.code == 127/);
    assert.match(controllerSource, /private val hostSession: ArcaneAndroidHostSession/);
    assert.match(controllerSource, /canonicalEntryPath\(hostSession\.entry\)/);
    assert.match(controllerSource, /AssetsPathHandler\(hostSession\.applicationContext\)/);
    assert.doesNotMatch(controllerSource, /context: Context/);
    assert.equal(controllerSource.match(/hostSession,/g)?.length, 4);
    assert.match(sessionSource, /validated != GeneratedAndroidApplicationRegistry\.BUNDLE_VERSION/);
    assert.doesNotMatch(sessionSource, /grantedCapabilities:/);
    assert.doesNotMatch(sessionSource, /application: ArcaneWebViewBridge\.ApplicationDescriptor/);
    assert.doesNotMatch(controllerSource, /capabilityGrantProvider: ArcaneWebViewBridge\.CapabilityGrantProvider/);
    assert.doesNotMatch(controllerSource, /platformStatusProvider: ArcaneWebViewBridge\.PlatformStatusProvider/);
});

test('Kotlin host normalizes platform status provider failures', async function testKotlinProviderFailure() {
    const source = await bundleSource('src/hosts/android/ArcaneWebViewBridge.kt');

    assert.match(source, /val status = try \{/);
    assert.match(source, /platformStatusProvider\.currentStatus\(\)/);
    assert.match(source, /"ANDROID_STATUS_UNAVAILABLE"/);
});

test('Android system ping is a capability-free bound bridge liveness response', async function testAndroidSystemPing() {
    const protocolSource = await bundleSource('src/hosts/android/AndroidBridgeProtocol.kt');
    const bridgeSource = await bundleSource('src/hosts/android/ArcaneWebViewBridge.kt');
    const registrySource = await bundleSource('src/hosts/android/GeneratedAndroidCapabilityRegistry.kt');
    assert.match(registrySource, /SYSTEM_PING_METHOD = "system\.ping"/);
    assert.match(registrySource, /internal fun isSupported\(method: String\): Boolean/);
    assert.match(protocolSource, /internal fun systemPingResponse\(request: Request\): String/);
    assert.match(protocolSource, /\.put\("result", JSONObject\(\)\.put\("ok", true\)\)/);
    const replayAdmission = bridgeSource.indexOf('replayWindow.remember(request.id)');
    const pingResponse = bridgeSource.indexOf('AndroidBridgeProtocol.systemPingResponse(request)');
    const grantProvider = bridgeSource.indexOf('val grantedCapabilities = readGrantedCapabilities()');
    const statusProvider = bridgeSource.indexOf('platformStatusProvider.currentStatus()');
    assert(replayAdmission >= 0 && pingResponse > replayAdmission, 'Ping must remain replay-bound.');
    assert(grantProvider > pingResponse, 'Ping must not invoke the capability-grant provider.');
    assert(statusProvider > pingResponse, 'Ping must not invoke the platform-status provider.');
    assert.doesNotMatch(protocolSource.match(/internal fun systemPingResponse[\s\S]*?\n    \}/)?.[0] || '', /pid|version|elevated|worker|health|ready/);
});

test('Android version and application identity are immutable provider-free session reads', async function testAndroidCurrentIdentity() {
    const protocolSource = await bundleSource('src/hosts/android/AndroidBridgeProtocol.kt');
    const bridgeSource = await bundleSource('src/hosts/android/ArcaneWebViewBridge.kt');
    const sessionSource = await bundleSource('src/hosts/android/ArcaneAndroidHostSession.kt');
    const registrySource = await bundleSource('src/hosts/android/GeneratedAndroidApplicationRegistry.kt');
    assert.match(registrySource, /BUNDLE_VERSION = "0\.8\.4"/);
    assert.match(sessionSource, /validated != GeneratedAndroidApplicationRegistry\.BUNDLE_VERSION/);
    assert.match(sessionSource, /override fun currentApplicationIdentity\(\): ArcaneWebViewBridge\.ApplicationDescriptor/);
    assert.match(protocolSource, /internal fun versionCurrentResponse\(request: Request, version: String\): String/);
    assert.match(protocolSource, /internal fun appCurrentResponse\(request: Request, application: Application\): String/);
    assert.match(protocolSource, /version == GeneratedAndroidApplicationRegistry\.BUNDLE_VERSION/);
    assert.match(protocolSource, /\.put\("securityMode", "unverified"\)/);
    assert.match(protocolSource, /\.put\("publisherTrustSource", JSONObject\.NULL\)/);
    assert.match(protocolSource, /\.put\("revocationStatus", JSONObject\.NULL\)/);
    const identityRead = bridgeSource.indexOf('applicationIdentityProvider.currentApplicationIdentity().copy()');
    const grantRead = bridgeSource.indexOf('val grantedCapabilities = readGrantedCapabilities()');
    const platformRead = bridgeSource.indexOf('platformStatusProvider.currentStatus()');
    const networkRead = bridgeSource.indexOf('networkStatusProvider.currentNetworkStatus()');
    const externalRead = bridgeSource.indexOf('externalOpenProvider.openMailto(canonicalUri)');
    assert(identityRead >= 0, 'Identity methods must read the immutable session snapshot.');
    assert.equal(bridgeSource.match(/applicationIdentityProvider\.currentApplicationIdentity\(\)/g)?.length, 1);
    assert.match(bridgeSource, /private val applicationIdentity: ApplicationDescriptor/);
    assert.match(bridgeSource, /status\.application != applicationIdentity \|\| status\.version != applicationIdentity\.version/);
    assert(grantRead > identityRead, 'Identity methods must return before capability-provider work.');
    assert(platformRead > identityRead, 'Identity methods must return before platform-provider work.');
    assert(networkRead > identityRead, 'Identity methods must return before network-provider work.');
    assert(externalRead > identityRead, 'Identity methods must return before external-provider work.');
    assert.match(bridgeSource, /request\.method == GeneratedAndroidCapabilityRegistry\.VERSION_CURRENT_METHOD/);
    assert.match(bridgeSource, /request\.method == GeneratedAndroidCapabilityRegistry\.APP_CURRENT_METHOD/);
});

test('Android user identity is a capability-gated privacy-minimized local session', async function testAndroidCurrentUser() {
    const protocolSource = await bundleSource('src/hosts/android/AndroidBridgeProtocol.kt');
    const bridgeSource = await bundleSource('src/hosts/android/ArcaneWebViewBridge.kt');
    const sessionSource = await bundleSource('src/hosts/android/ArcaneAndroidHostSession.kt');
    const registrySource = await bundleSource('src/hosts/android/GeneratedAndroidCapabilityRegistry.kt');
    const shellSource = await bundleSource('src/frontend/shell/index.html');
    assert.match(registrySource, /USER_CURRENT_METHOD = "user\.current"/);
    assert.match(registrySource, /USER_CURRENT_CAPABILITY = "identity\.read"/);
    assert.match(sessionSource, /identityKind = "local-session"/);
    assert.match(sessionSource, /username = null/);
    assert.match(sessionSource, /accountName = null/);
    assert.match(sessionSource, /displayName = "Local user"/);
    assert.match(sessionSource, /source = "android"/);
    assert.equal(bridgeSource.match(/userIdentityProvider\.currentUserIdentity\(\)/g)?.length, 1);
    assert.match(protocolSource, /internal fun userCurrentResponse/);
    assert.match(protocolSource, /identity\.identityKind == "local-session"/);
    assert.match(protocolSource, /identity\.username == null/);
    assert.match(protocolSource, /identity\.accountName == null/);
    assert.match(protocolSource, /identity\.source == "android"/);
    assert.match(shellSource, /user\.accountName \|\| user\.username \|\| user\.displayName/);
    const grantAdmission = bridgeSource.indexOf('val grantedCapabilities = readGrantedCapabilities()');
    const replayAdmission = bridgeSource.lastIndexOf('replayWindow.remember(request.id)');
    const userResponse = bridgeSource.indexOf('AndroidBridgeProtocol.userCurrentResponse(request, userIdentity)');
    const platformRead = bridgeSource.indexOf('platformStatusProvider.currentStatus()');
    assert(grantAdmission >= 0 && replayAdmission > grantAdmission, 'User identity must remain capability and replay gated.');
    assert(userResponse > replayAdmission && platformRead > userResponse, 'User identity must return before unrelated platform-provider work.');
    for (const prohibited of ['AccountManager', 'GET_ACCOUNTS', 'READ_CONTACTS', 'ANDROID_ID', 'UserHandle', 'Build.FINGERPRINT', 'Build.SERIAL']) {
        assert.doesNotMatch(`${protocolSource}\n${bridgeSource}\n${sessionSource}`, new RegExp(prohibited));
    }
});

test('Android external open is exact, mailto-only, capability-gated, and handler-pinned', async function testAndroidExternalOpen() {
    const protocolSource = await bundleSource('src/hosts/android/AndroidBridgeProtocol.kt');
    const contractSource = await bundleSource('src/hosts/android/GeneratedAndroidMethodContracts.kt');
    const bridgeSource = await bundleSource('src/hosts/android/ArcaneWebViewBridge.kt');
    const adapterSource = await bundleSource('src/hosts/android/ArcaneAndroidSystemAdapter.kt');

    assert.match(contractSource, /EXTERNAL_OPEN_INPUT_MAX_URI_LENGTH = 4096/);
    assert.match(contractSource, /EXTERNAL_OPEN_OUTPUT_MAX_URI_LENGTH = 4096/);
    assert.match(protocolSource, /GeneratedAndroidMethodContracts\.EXTERNAL_OPEN_INPUT_MAX_URI_LENGTH/);
    assert.match(protocolSource, /hasExactKeys\(parameters, setOf\("uri"\)\)/);
    assert.match(protocolSource, /value != value\.trim\(\)/);
    assert.match(protocolSource, /character\.code < 33 \|\| character\.code > 126/);
    assert.match(protocolSource, /scheme\.equals\(GeneratedAndroidMethodContracts\.EXTERNAL_OPEN_INPUT_SCHEME, ignoreCase = true\)/);
    assert.match(protocolSource, /GeneratedAndroidMethodContracts\.EXTERNAL_OPEN_INPUT_SCHEME \+ validated\.substring\(separator\)/);
    assert.match(protocolSource, /internal fun externalOpenResponse\(request: Request, uri: String\): String/);
    assert.match(protocolSource, /\.put\("opened", true\)/);
    assert.match(protocolSource, /\.put\("uri", canonicalUri\)/);
    assert.match(bridgeSource, /fun interface ExternalOpenProvider/);
    assert.match(bridgeSource, /externalOpenProvider\.openMailto\(canonicalUri\)/);
    assert.match(bridgeSource, /"EXTERNAL_SCHEME_NOT_ALLOWED"/);
    assert.match(bridgeSource, /AndroidBridgeProtocol\.isValidApplication\(application\)/);
    const identityValidation = bridgeSource.indexOf('AndroidBridgeProtocol.isValidApplication(application)');
    const providerCall = bridgeSource.indexOf('externalOpenProvider.openMailto(canonicalUri)');
    assert(identityValidation >= 0 && providerCall > identityValidation, 'Android must validate the complete application identity before external provider work.');
    assert.equal(bridgeSource.match(/capabilityGrantProvider\.isGranted\(methodCapability\)/g)?.length, 1);
    assert.match(bridgeSource, /statusResponseFor\([\s\S]*grantedCapabilities\.grants,[\s\S]*grantedCapabilities\.methods/);
    assert.match(bridgeSource, /"EXTERNAL_OPEN_FAILED"/);
    assert.match(adapterSource, /Intent\(Intent\.ACTION_SENDTO, Uri\.parse\(canonicalUri\)\)/);
    assert.match(adapterSource, /AndroidBridgeProtocol\.canonicalMailtoUri\(uri\)/);
    assert.match(adapterSource, /scheme\.equals\(GeneratedAndroidMethodContracts\.EXTERNAL_OPEN_INPUT_SCHEME, ignoreCase = true\)/);
    assert.match(adapterSource, /Intent\.FLAG_ACTIVITY_NEW_TASK/);
    assert.match(adapterSource, /resolveActivity\(intent, PackageManager\.MATCH_DEFAULT_ONLY\)/);
    assert.match(adapterSource, /val activity = handler\.activityInfo \?: return false/);
    assert.match(adapterSource, /if \(!activity\.exported\) return false/);
    assert.match(adapterSource, /intent\.setClassName\(activity\.packageName, activity\.name\)/);
    assert.match(adapterSource, /applicationContext\.startActivity\(intent\)/);
    assert.doesNotMatch(adapterSource, /ACTION_VIEW|Intent\.parseUri|createChooser|startActivityForResult|addCategory|setDataAndType/);
    assert.doesNotMatch(adapterSource, /\{[^\r\n]*->|runCatching|\.map\(|\.any\s*\{|\.all\s*\{|\.none\s*\{/);
});

test('Android network status exposes only bounded connectivity state after authorization and identity binding', async function testAndroidNetworkStatus() {
    const protocolSource = await bundleSource('src/hosts/android/AndroidBridgeProtocol.kt');
    const contractSource = await bundleSource('src/hosts/android/GeneratedAndroidMethodContracts.kt');
    const bridgeSource = await bundleSource('src/hosts/android/ArcaneWebViewBridge.kt');
    const adapterSource = await bundleSource('src/hosts/android/ArcaneAndroidSystemAdapter.kt');

    assert.match(protocolSource, /method == GeneratedAndroidCapabilityRegistry\.NETWORK_STATUS_METHOD/);
    assert.match(contractSource, /NETWORK_STATUS_OUTPUT_MAX_INTERFACE_COUNT = 64/);
    assert.match(protocolSource, /internal fun networkStatusResponse\(request: Request, online: Boolean, interfaceCount: Int\): String/);
    assert.match(protocolSource, /interfaceCount < 0/);
    assert.match(protocolSource, /interfaceCount > GeneratedAndroidMethodContracts\.NETWORK_STATUS_OUTPUT_MAX_INTERFACE_COUNT/);
    assert.match(protocolSource, /online != \(interfaceCount > 0\)/);
    assert.match(protocolSource, /\.put\("online", online\)/);
    assert.match(protocolSource, /\.put\("interfaceCount", interfaceCount\)/);
    assert.match(contractSource, /PLATFORM_STATUS_OUTPUT_MAX_STATUS_STRING_LENGTH = 256/);
    assert.match(contractSource, /PLATFORM_STATUS_OUTPUT_MAX_LIST_ITEMS = 256/);
    assert.match(protocolSource, /GeneratedAndroidMethodContracts\.PLATFORM_STATUS_OUTPUT_MAX_STATUS_STRING_LENGTH/);
    assert.match(bridgeSource, /data class NetworkStatus\(/);
    assert.match(bridgeSource, /fun interface NetworkStatusProvider/);
    assert.match(bridgeSource, /networkStatusProvider\.currentNetworkStatus\(\)/);
    assert.match(bridgeSource, /"NETWORK_STATUS_UNAVAILABLE"/);
    const identityValidation = bridgeSource.indexOf('AndroidBridgeProtocol.isValidApplication(application)');
    const providerCall = bridgeSource.indexOf('networkStatusProvider.currentNetworkStatus()');
    assert(identityValidation >= 0 && providerCall > identityValidation, 'Android must validate the complete application identity before reading network state.');
    assert.match(adapterSource, /NetworkInterface\.getNetworkInterfaces\(\)/);
    assert.match(adapterSource, /networkInterface\.inetAddresses/);
    assert.match(adapterSource, /!address\.isLoopbackAddress/);
    assert.match(adapterSource, /ArcaneWebViewBridge\.NetworkStatus\(interfaceCount > 0, interfaceCount\)/);
    assert.match(adapterSource, /interfaceCount > GeneratedAndroidMethodContracts\.NETWORK_STATUS_OUTPUT_MAX_INTERFACE_COUNT/);
    assert.doesNotMatch(adapterSource, /ConnectivityManager|NetworkCapabilities|WifiManager|TelephonyManager|SSID|BSSID|getLinkProperties|ACCESS_NETWORK_STATE|ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION/);
});

test('Kotlin host disables direct file and content access and exposes no legacy authority bridge', async function testKotlinHostHardening() {
    const source = await bundleSource('src/hosts/android/ArcaneWebViewBridge.kt');

    for (const setting of [
        'allowFileAccess',
        'allowContentAccess',
        'allowFileAccessFromFileURLs',
        'allowUniversalAccessFromFileURLs'
    ]) {
        assert.match(source, new RegExp(`webView\\.settings\\.${setting} = false`));
    }
    for (const forbidden of [
        /addJavascriptInterface/,
        /java\.lang\.reflect/,
        /Class\.forName/,
        /getDeclared(?:Method|Field|Constructor)/,
        /Runtime\.getRuntime/,
        /ProcessBuilder/,
        /\bexec\s*\(/,
        /\/system\/bin\/(?:sh|su)/,
        /\b(?:sh|su)\s+-c\b/
    ]) {
        assert.doesNotMatch(source, forbidden);
    }
});

test('Android host controller serves only packaged assets from the reserved HTTPS origin', async function testAndroidAssetLoader() {
    const source = await bundleSource('src/hosts/android/ArcaneWebViewHostController.kt');

    assert.match(source, /WebViewAssetLoader\.Builder\(\)/);
    assert.match(source, /\.setHttpAllowed\(false\)/);
    assert.match(source, /\.addPathHandler\(ASSET_PREFIX, WebViewAssetLoader\.AssetsPathHandler\(hostSession\.applicationContext\)\)/);
    assert.match(source, /TRUSTED_HOST = "appassets\.androidplatform\.net"/);
    assert.match(source, /ASSET_PREFIX = "\/arcane\/"/);
    assert.match(source, /assetLoader\.shouldInterceptRequest\(uri\) \?: forbiddenResponse\(\)/);
    assert.match(source, /if \(!isTrustedAssetUri\(uri\)\) \{\s*return forbiddenResponse\(\)/);
    assert.match(source, /mapOf\("Cache-Control" to "no-store"\)/);
    assert.match(source, /403,/);
});

test('Android host controller binds one exact main-frame entry and safe asset paths', async function testAndroidNavigationPolicy() {
    const source = await bundleSource('src/hosts/android/ArcaneWebViewHostController.kt');

    assert.match(source, /private val allowedEntry = canonicalEntryPath\(hostSession\.entry\)/);
    assert.match(source, /private val allowedEntryUri = entryUri\(allowedEntry\)/);
    assert.match(source, /private var installedWebView: WebView\? = null/);
    assert.match(source, /private var lifecycle = Lifecycle\.NEW/);
    assert.match(source, /if \(lifecycle != Lifecycle\.NEW\) \{/);
    assert.match(source, /if \(installedWebView !== webView/);
    assert.match(source, /if \(!request\.isForMainFrame\) return false/);
    assert.match(source, /return !isAllowedEntry\(request\.url\)/);
    assert.match(source, /request\.isForMainFrame && !isAllowedEntry\(uri\)/);
    assert.match(source, /override fun onPageStarted/);
    assert.match(source, /view\.stopLoading\(\)/);
    assert.match(source, /view\.loadUrl\(BLANK_URI\)/);
    assert.match(source, /uri\.query != null \|\| uri\.fragment != null/);
    assert.match(source, /normalizedEncodedPath\.contains\("%2f"\)/);
    assert.match(source, /normalizedEncodedPath\.contains\("%5c"\)/);
    assert.match(source, /for \(segment in decodedPath\.split\('\/'\)\)/);
    assert.match(source, /private fun isAsciiEntryCharacter\(character: Char\): Boolean/);
    assert.match(source, /request\.method\.equals\("GET", ignoreCase = false\)/);
    assert.doesNotMatch(source, /android\.content\.Intent|ACTION_VIEW|startActivity|setDomain\(/);
    assert.doesNotMatch(source, /\{[^\r\n]*->|runCatching|\.map\(|\.any\s*\{|\.all\s*\{|\.none\s*\{/);
});

test('Android controller hardens WebView before enabling JavaScript and loading entries', async function testAndroidControllerOrdering() {
    const source = await bundleSource('src/hosts/android/ArcaneWebViewHostController.kt');
    const harden = source.indexOf('hardenSettings(webView.settings)');
    const hardenServiceWorkers = source.indexOf('hardenServiceWorkers()');
    const bridge = source.indexOf('ArcaneWebViewBridge.install(');
    const client = source.indexOf('webView.webViewClient = Client()');
    const enableJavaScript = source.indexOf('webView.settings.javaScriptEnabled = true');

    assert(harden >= 0 && hardenServiceWorkers > harden && bridge > hardenServiceWorkers && client > bridge && enableJavaScript > client, 'Android controller must harden WebView and service-worker settings and install the bridge/client before enabling JavaScript.');
    for (const token of [
        'settings.allowFileAccess = false',
        'settings.allowContentAccess = false',
        'settings.allowFileAccessFromFileURLs = false',
        'settings.allowUniversalAccessFromFileURLs = false',
        'settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW',
        'settings.setSupportMultipleWindows(false)',
        'settings.javaScriptCanOpenWindowsAutomatically = false'
    ]) {
        assert(source.includes(token), `Android controller is missing ${token}`);
    }
    assert.match(source, /ServiceWorkerController\.getInstance\(\)\.serviceWorkerWebSettings/);
    assert.match(source, /private fun hardenServiceWorkers\(\)[\s\S]*settings\.allowFileAccess = false[\s\S]*settings\.allowContentAccess = false[\s\S]*settings\.blockNetworkLoads = true/);
    assert.doesNotMatch(source, /require\s*\([^\r\n]*\)\s*\{/);
});

test('Android controller teardown removes bridge authority and permanently closes the controller', async function testAndroidControllerClose() {
    const source = await bundleSource('src/hosts/android/ArcaneWebViewHostController.kt');

    assert.match(source, /data class CloseResult\(/);
    assert.match(source, /val authorityRevoked: Boolean/);
    assert.match(source, /val destroyed: Boolean/);
    assert.match(source, /val retryable: Boolean/);
    assert.match(source, /val failures: List<String>/);
    assert.match(source, /@UiThread\s+fun close\(webView: WebView\): CloseResult/);
    assert.match(source, /private var installedLooper: Looper\? = null/);
    assert.match(source, /return CloseResult\(false, false, true, listOf\("WRONG_THREAD"\)\)/);
    assert.match(source, /var authorityRevoked = lifecycle == Lifecycle\.AUTHORITY_REVOKED/);
    assert.match(source, /Lifecycle\.CLOSING/);
    assert.match(source, /WebViewFeature\.isFeatureSupported\(WebViewFeature\.WEB_MESSAGE_LISTENER\)/);
    assert.match(source, /WebViewCompat\.removeWebMessageListener\(webView, ArcaneWebViewBridge\.BRIDGE_NAME\)/);
    assert.match(source, /webView\.stopLoading\(\)/);
    assert.match(source, /if \(parent is ViewGroup\)/);
    assert.match(source, /parent\.removeView\(webView\)/);
    assert.match(source, /if \(webView\.parent == null\)/);
    assert.match(source, /webView\.destroy\(\)/);
    assert.match(source, /lifecycle = Lifecycle\.CLOSED/);
    assert.match(source, /lifecycle = Lifecycle\.AUTHORITY_REVOKED/);
    assert.match(source, /return CloseResult\(authorityRevoked, destroyed, !destroyed, failures\.toList\(\)\)/);
    assert.match(source, /fun loadEntry[\s\S]*if \(lifecycle != Lifecycle\.INSTALLED\) return false/);
    assert.match(source, /private enum class Lifecycle \{\s*NEW,\s*CLOSING,\s*INSTALLED,\s*AUTHORITY_REVOKED,\s*CLOSED/);
    for (const failure of [
        'BRIDGE_REMOVAL_FAILED',
        'STOP_LOADING_FAILED',
        'PARENT_DETACH_FAILED',
        'WEBVIEW_DESTROY_FAILED'
    ]) {
        assert(source.includes(`failures.add("${failure}")`), `Android teardown must report ${failure}.`);
    }
    const listenerRemoval = source.indexOf('WebViewCompat.removeWebMessageListener');
    const destroy = source.indexOf('webView.destroy()');
    assert(
        listenerRemoval >= 0 && destroy > listenerRemoval,
        'Android teardown must attempt bridge-authority removal before destroying the WebView.'
    );
    assert.doesNotMatch(source, /WeakReference<WebView>/);
});

test('Android controller rolls back partial bridge installation through retryable teardown', async function testAndroidInstallRollback() {
    const source = await bundleSource('src/hosts/android/ArcaneWebViewHostController.kt');
    const lifecycleBeforeBridge = source.indexOf('lifecycle = Lifecycle.CLOSING');
    const bridgeInstall = source.indexOf('ArcaneWebViewBridge.install(');
    const clientAssignment = source.indexOf('webView.webViewClient = Client()');
    const installedState = source.indexOf('lifecycle = Lifecycle.INSTALLED');

    assert(lifecycleBeforeBridge >= 0 && bridgeInstall > lifecycleBeforeBridge, 'Android must retain cleanup authority before bridge installation begins.');
    assert(clientAssignment > bridgeInstall && installedState > clientAssignment, 'Android must not report installation before all post-bridge setup succeeds.');
    assert.match(source, /data class InstallResult\(/);
    assert.match(source, /val cleanupRequired: Boolean/);
    assert.match(source, /val closeResult: CloseResult\?/);
    assert.match(source, /val errorCode: String\?/);
    assert.match(source, /fun install\([\s\S]*\): InstallResult/);
    assert.match(source, /val bridgeInstalled = try \{/);
    assert.match(source, /catch \(_: Exception\) \{\s*val closeResult = close\(webView\)\s*return InstallResult\(false, closeResult\.retryable, closeResult, "BRIDGE_INSTALL_FAILED"\)/);
    assert.match(source, /if \(!bridgeInstalled\) \{\s*resetUninstalled\(\)\s*return InstallResult\(false, false, null, "WEB_MESSAGE_LISTENER_UNSUPPORTED"\)/);
    assert.match(source, /webView\.settings\.javaScriptEnabled = true\s*\} catch \(_: Exception\) \{\s*val closeResult = close\(webView\)\s*return InstallResult\(false, closeResult\.retryable, closeResult, "WEBVIEW_SETUP_FAILED"\)/);
    assert.match(source, /return InstallResult\(true, false, null, null\)/);
    assert.match(source, /private fun resetUninstalled\(\)/);
});
