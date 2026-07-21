(function installSystemPlatformPresentation(globalObject) {
    'use strict';

    const KERNEL_TYPES = Object.freeze(['nt', 'linux']);

    function normalizedValue(value) {
        return typeof value === 'string' ? value.trim().toLowerCase() : '';
    }

    function kernelType(status = {}) {
        const candidates = [
            status.kernelType,
            status.platform,
            status.rawPlatform,
            status.execution?.effectivePlatform,
            status.execution?.hostPlatform,
        ].map(normalizedValue);

        for (const value of candidates) {
            if (value === 'windows' || value === 'win32' || value === 'nt') return 'nt';
            if (value === 'linux') return 'linux';
        }
        return null;
    }

    function displayName(status = {}) {
        const kernel = kernelType(status);
        if (kernel === 'nt') return 'Microsoft NT';
        if (kernel === 'linux') return 'Linux';
        if (typeof status.displayName === 'string' && status.displayName.trim()) return status.displayName.trim();
        if (typeof status.platform === 'string' && status.platform.trim()) return status.platform.trim();
        return 'Unknown operating system';
    }

    function apply(status = {}, root = globalObject.document?.documentElement) {
        const kernel = kernelType(status);
        if (root?.classList) {
            root.classList.remove('arcane-kernel', ...KERNEL_TYPES.map((type) => `arcane-kernel-${type}`));
            if (kernel) root.classList.add('arcane-kernel', `arcane-kernel-${kernel}`);
        }
        if (root?.dataset) {
            if (kernel) root.dataset.arcaneKernel = kernel;
            else delete root.dataset.arcaneKernel;
        }

        // This marker is presentation metadata only. Native permission evidence remains authoritative.
        return Object.freeze({ kernelType: kernel, displayName: displayName(status) });
    }

    globalObject.ArcaneSystemPlatformPresentation = Object.freeze({ kernelType, displayName, apply });
})(globalThis);
