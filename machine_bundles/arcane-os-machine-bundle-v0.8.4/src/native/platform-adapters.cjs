'use strict';

const CORE_PLATFORM_ADAPTER_FACTORIES = Object.freeze(
    {
        win32: createWindowsNativeAdapter,
        linux: createLinuxNativeAdapter
    }
);
const SUPPORTED_CORE_PLATFORMS = Object.freeze(
    Object.keys(CORE_PLATFORM_ADAPTER_FACTORIES)
);

function listSupportedCorePlatforms() {
    return SUPPORTED_CORE_PLATFORMS;
}

function createCoreNativeAdapter(platform, context) {
    if (typeof platform !== 'string') {
        throw new TypeError('Core platform must be a string.');
    }

    if (context === null || typeof context !== 'object' || Array.isArray(context)) {
        throw new TypeError('Native adapter context must be an object.');
    }

    const platformIsSupported = Object.prototype.hasOwnProperty.call(
        CORE_PLATFORM_ADAPTER_FACTORIES,
        platform
    );
    if (!platformIsSupported) {
        return null;
    }

    const createAdapter = CORE_PLATFORM_ADAPTER_FACTORIES[platform];
    return createAdapter(context);
}
