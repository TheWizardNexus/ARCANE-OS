package os.arcane.host.android

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

internal class ArcaneAndroidApplicationCatalog(context: Context) {
    private val applicationContext = context.applicationContext

    internal data class LaunchDescriptor(
        val id: String,
        val displayName: String,
        val type: String,
        val entry: String,
        val assetRoot: String,
        val navigationEntries: Set<String>,
        val requestedCapabilities: Set<String>,
        val packageName: String? = null
    )

    internal data class Snapshot(
        val publicCatalog: ArcaneWebViewBridge.ApplicationCatalog,
        val launchDescriptors: Map<String, LaunchDescriptor>
    ) {
        internal fun requireLaunchDescriptor(id: String): LaunchDescriptor {
            return launchDescriptors[id]
                ?: throw IllegalArgumentException("Android application is not in the packaged catalog.")
        }
    }

    private data class CatalogEntry(
        val id: String,
        val displayName: String,
        val description: String,
        val icon: String,
        val order: Int,
        val version: String,
        val capabilities: List<String>,
        val contentManifestSha256: String,
        val packageManifestSha256: String
    )

    private data class ContentFile(
        val size: Long,
        val sha256: String
    )

    private data class InstalledCatalogEntry(
        val id: String,
        val displayName: String,
        val description: String,
        val icon: String,
        val order: Int,
        val version: String,
        val packageName: String
    )

    internal fun read(): ArcaneWebViewBridge.ApplicationCatalog {
        return readSnapshot().publicCatalog
    }

    internal fun readInstalledSnapshot(): Snapshot {
        val root = JSONObject(readAssetText(LAUNCHER_CATALOG_ASSET))
        requireExactKeys(root, setOf("schemaVersion", "protocolVersion", "bundleVersion", "apps"))
        require(root.getInt("schemaVersion") == 1)
        require(root.getString("protocolVersion") == PROTOCOL)
        require(root.getString("bundleVersion") == GeneratedAndroidApplicationRegistry.BUNDLE_VERSION)
        val entries = validatedInstalledCatalogEntries(root.getJSONArray("apps"))
        val debugBuild = applicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        val descriptors = LinkedHashMap<String, LaunchDescriptor>()
        val applications = mutableListOf<ArcaneWebViewBridge.ApplicationCatalogRecord>()
        for (entry in entries) {
            if (!isInstalledLaunchablePackage(entry)) continue
            verifyAsset(entry.icon, null)
            descriptors[entry.id] = LaunchDescriptor(
                id = entry.id,
                displayName = entry.displayName,
                type = "app",
                entry = "${entry.id}/index.html",
                assetRoot = "",
                navigationEntries = emptySet(),
                requestedCapabilities = emptySet(),
                packageName = entry.packageName
            )
            applications.add(
                ArcaneWebViewBridge.ApplicationCatalogRecord(
                    id = entry.id,
                    displayName = entry.displayName,
                    description = entry.description,
                    iconUrl = "/arcane/${entry.icon}",
                    version = entry.version,
                    order = entry.order,
                    verified = debugBuild
                )
            )
        }
        return Snapshot(
            ArcaneWebViewBridge.ApplicationCatalog(
                verified = debugBuild,
                securityMode = if (debugBuild) "unsigned-local-test" else "unverified",
                publisherTrustSource = null,
                revocationStatus = null,
                applications = applications.toList()
            ),
            descriptors.toMap()
        )
    }

    internal fun readSnapshot(): Snapshot {
        val root = JSONObject(readAssetText(CATALOG_ASSET))
        requireExactKeys(root, setOf("schemaVersion", "protocolVersion", "bundleVersion", "apps"))
        require(root.getInt("schemaVersion") == 1)
        require(root.getString("protocolVersion") == PROTOCOL)
        require(root.getString("bundleVersion") == GeneratedAndroidApplicationRegistry.BUNDLE_VERSION)
        val entries = validatedCatalogEntries(root.getJSONArray("apps"))
        val descriptors = LinkedHashMap<String, LaunchDescriptor>()
        for (entry in entries) {
            descriptors[entry.id] = validatedLaunchDescriptor(entry)
        }
        val debugBuild = applicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        val applications = entries.map { entry ->
            ArcaneWebViewBridge.ApplicationCatalogRecord(
                id = entry.id,
                displayName = entry.displayName,
                description = entry.description,
                iconUrl = "/arcane/${entry.icon}",
                version = entry.version,
                order = entry.order,
                verified = debugBuild
            )
        }
        val catalog = ArcaneWebViewBridge.ApplicationCatalog(
            verified = debugBuild,
            securityMode = if (debugBuild) "unsigned-local-test" else "unverified",
            publisherTrustSource = null,
            revocationStatus = null,
            applications = applications
        )
        return Snapshot(catalog, descriptors.toMap())
    }

    private fun validatedCatalogEntries(entries: JSONArray): List<CatalogEntry> {
        require(entries.length() in 0..MAX_APPLICATIONS)
        val applications = mutableListOf<CatalogEntry>()
        val identifiers = mutableSetOf<String>()
        var previousOrder = -1
        for (index in 0 until entries.length()) {
            val entry = entries.getJSONObject(index)
            requireExactKeys(
                entry,
                setOf(
                    "id",
                    "displayName",
                    "description",
                    "icon",
                    "order",
                    "version",
                    "capabilities",
                    "contentManifestSha256",
                    "packageManifestSha256"
                )
            )
            val id = entry.getString("id")
            val displayName = entry.getString("displayName")
            val description = entry.getString("description")
            val icon = entry.getString("icon")
            val order = entry.getInt("order")
            val version = entry.getString("version")
            val capabilities = validatedCapabilities(entry.getJSONArray("capabilities"))
            val contentManifestSha256 = entry.getString("contentManifestSha256")
            val packageManifestSha256 = entry.getString("packageManifestSha256")
            require(APPLICATION_ID.matches(id) && identifiers.add(id))
            require(displayName.isNotEmpty() && displayName.length <= 80)
            require(description.length <= 240)
            require(isSafeAssetPath(icon))
            require(icon.startsWith("$id/app/"))
            require(order > previousOrder)
            require(version == GeneratedAndroidApplicationRegistry.BUNDLE_VERSION)
            require(SHA256.matches(contentManifestSha256))
            require(SHA256.matches(packageManifestSha256))
            applications.add(
                CatalogEntry(
                    id,
                    displayName,
                    description,
                    icon,
                    order,
                    version,
                    capabilities,
                    contentManifestSha256,
                    packageManifestSha256
                )
            )
            previousOrder = order
        }
        return applications.toList()
    }

    private fun validatedInstalledCatalogEntries(entries: JSONArray): List<InstalledCatalogEntry> {
        require(entries.length() in 0..MAX_APPLICATIONS)
        val applications = mutableListOf<InstalledCatalogEntry>()
        val identifiers = mutableSetOf<String>()
        val packageNames = mutableSetOf<String>()
        var previousOrder = -1
        for (index in 0 until entries.length()) {
            val entry = entries.getJSONObject(index)
            requireExactKeys(
                entry,
                setOf("id", "displayName", "description", "icon", "order", "version", "packageName")
            )
            val id = entry.getString("id")
            val displayName = entry.getString("displayName")
            val description = entry.getString("description")
            val icon = canonicalRelativePath(entry.getString("icon"))
            val order = entry.getInt("order")
            val version = entry.getString("version")
            val packageName = entry.getString("packageName")
            require(APPLICATION_ID.matches(id) && identifiers.add(id))
            require(displayName.isNotEmpty() && displayName.length <= 80)
            require(description.length <= 240)
            require(icon.startsWith("launcher-icons/$id."))
            require(order > previousOrder)
            require(version == GeneratedAndroidApplicationRegistry.BUNDLE_VERSION)
            require(ANDROID_PACKAGE.matches(packageName) && packageNames.add(packageName))
            applications.add(InstalledCatalogEntry(id, displayName, description, icon, order, version, packageName))
            previousOrder = order
        }
        return applications.toList()
    }

    @Suppress("DEPRECATION")
    private fun isInstalledLaunchablePackage(entry: InstalledCatalogEntry): Boolean {
        val packageInfo = try {
            applicationContext.packageManager.getPackageInfo(entry.packageName, 0)
        } catch (_: PackageManager.NameNotFoundException) {
            return false
        }
        if (packageInfo.versionName != entry.version || packageInfo.applicationInfo?.enabled != true) return false
        val launchIntent = applicationContext.packageManager.getLaunchIntentForPackage(entry.packageName) ?: return false
        val resolved = applicationContext.packageManager.resolveActivity(launchIntent, PackageManager.MATCH_DEFAULT_ONLY)
            ?: return false
        return resolved.activityInfo?.exported == true && resolved.activityInfo?.packageName == entry.packageName
    }

    private fun validatedLaunchDescriptor(entry: CatalogEntry): LaunchDescriptor {
        val packageAsset = "${entry.id}/$PACKAGE_MANIFEST"
        val packageBytes = readAssetBytes(packageAsset)
        require(sha256(packageBytes) == entry.packageManifestSha256)
        val packageRoot = JSONObject(packageBytes.toString(Charsets.UTF_8))
        requireExactKeys(
            packageRoot,
            setOf("schemaVersion", "protocolVersion", "bundleVersion", "app", "files")
        )
        require(packageRoot.getInt("schemaVersion") == 1)
        require(packageRoot.getString("protocolVersion") == PROTOCOL)
        require(packageRoot.getString("bundleVersion") == entry.version)
        val packageFiles = validatedFileInventory(
            packageRoot.getJSONArray("files"),
            MAX_PACKAGE_FILES
        )
        val app = packageRoot.getJSONObject("app")
        requireExactKeys(
            app,
            setOf(
                "id",
                "displayName",
                "description",
                "icon",
                "order",
                "type",
                "entry",
                "launchEntry",
                "capabilities",
                "security",
                "documentCatalog"
            )
        )
        require(app.getString("id") == entry.id)
        require(app.getString("displayName") == entry.displayName)
        require(app.getString("description") == entry.description)
        val appIcon = canonicalRelativePath(app.getString("icon"))
        require(entry.icon == "${entry.id}/app/${entry.id}/$appIcon")
        require(app.getInt("order") == entry.order)
        require(app.getString("type") == "app")
        val launchEntry = canonicalRelativePath(app.getString("launchEntry"))
        require(app.getString("entry") == launchEntry)
        require(validatedCapabilities(app.getJSONArray("capabilities")) == entry.capabilities)
        val security = app.getJSONObject("security")
        requireExactKeys(
            security,
            setOf("contentSecurityPolicy", "permissionsPolicy", "securedDocuments", "navigationEntries", "verifiedDependencies")
        )
        val navigationEntries = validatedNavigationEntries(entry.id, launchEntry, security.getJSONArray("navigationEntries"))

        val contentAsset = "${entry.id}/$CONTENT_MANIFEST"
        val contentBytes = readAssetBytes(contentAsset)
        require(sha256(contentBytes) == entry.contentManifestSha256)
        val contentFiles = validatedContentFiles(entry, JSONObject(contentBytes.toString(Charsets.UTF_8)))
        require(contentFiles == packageFiles.filterKeys { path -> path.startsWith(APP_FILE_PREFIX) })
        for (navigationEntry in navigationEntries) {
            val packagePath = "app/${navigationEntry.removePrefix("${entry.id}/app/")}"
            val contentFile = contentFiles[packagePath] ?: throw IllegalArgumentException("Android application navigation asset is not bound.")
            verifyAsset("${entry.id}/$packagePath", contentFile)
        }

        return LaunchDescriptor(
            id = entry.id,
            displayName = entry.displayName,
            type = "app",
            entry = launchEntry,
            assetRoot = "${entry.id}/app",
            navigationEntries = navigationEntries.mapTo(linkedSetOf()) { value ->
                value.removePrefix("${entry.id}/app/")
            }.toSet(),
            requestedCapabilities = entry.capabilities.toSet()
        )
    }

    private fun validatedNavigationEntries(id: String, launchEntry: String, values: JSONArray): Set<String> {
        require(values.length() in 1..MAX_NAVIGATION_ENTRIES)
        val entries = LinkedHashSet<String>()
        for (index in 0 until values.length()) {
            val value = values.getString(index)
            require(value.startsWith('/') && !value.startsWith("//"))
            val relative = canonicalRelativePath(value.removePrefix("/"))
            require(relative.startsWith("$id/"))
            require(entries.add("$id/app/$relative"))
        }
        require(entries.contains("$id/app/$launchEntry"))
        return entries.toSet()
    }

    private fun validatedContentFiles(entry: CatalogEntry, root: JSONObject): Map<String, ContentFile> {
        requireExactKeys(root, setOf("schemaVersion", "hashAlgorithm", "app", "files"))
        require(root.getInt("schemaVersion") == 1)
        require(root.getString("hashAlgorithm") == "sha256")
        val application = root.getJSONObject("app")
        requireExactKeys(application, setOf("id", "version"))
        require(application.getString("id") == entry.id)
        require(application.getString("version") == entry.version)
        return validatedFileInventory(root.getJSONArray("files"), MAX_CONTENT_FILES)
    }

    private fun validatedFileInventory(values: JSONArray, maximumFiles: Int): Map<String, ContentFile> {
        require(values.length() <= maximumFiles)
        val files = LinkedHashMap<String, ContentFile>()
        for (index in 0 until values.length()) {
            val value = values.getJSONObject(index)
            requireExactKeys(value, setOf("path", "size", "sha256"))
            val pathValue = value.opt("path")
            val sizeValue = value.opt("size")
            val hashValue = value.opt("sha256")
            require(pathValue is String)
            val size = when (sizeValue) {
                is Int -> sizeValue.toLong()
                is Long -> sizeValue
                else -> throw IllegalArgumentException("Android application file size is invalid.")
            }
            require(hashValue is String)
            val path = canonicalRelativePath(pathValue)
            val hash = hashValue
            require(size >= 0 && SHA256.matches(hash))
            require(files.put(path, ContentFile(size, hash)) == null)
        }
        return files.toMap()
    }

    private fun verifyAsset(assetPath: String, expected: ContentFile?) {
        val bytes = readAssetBytes(assetPath)
        if (expected != null) {
            require(bytes.size.toLong() == expected.size)
            require(sha256(bytes) == expected.sha256)
        }
    }

    private fun validatedCapabilities(capabilities: JSONArray): List<String> {
        val values = mutableListOf<String>()
        var previous: String? = null
        for (index in 0 until capabilities.length()) {
            val capability = capabilities.getString(index)
            require(CAPABILITY.matches(capability) && !values.contains(capability))
            require(previous == null || previous!! < capability)
            values.add(capability)
            previous = capability
        }
        return values.toList()
    }

    private fun canonicalRelativePath(value: String): String {
        require(isSafeAssetPath(value))
        require(value.length <= MAX_ASSET_PATH_LENGTH)
        return value
    }

    private fun isSafeAssetPath(value: String): Boolean {
        if (value.isEmpty() || value.startsWith('/') || value.endsWith('/') || value.contains('\\')) return false
        for (segment in value.split('/')) {
            if (segment.isEmpty() || segment == "." || segment == "..") return false
        }
        return ASSET_PATH.matches(value)
    }

    private fun readAssetText(path: String): String {
        return readAssetBytes(path).toString(Charsets.UTF_8)
    }

    private fun readAssetBytes(path: String): ByteArray {
        return applicationContext.assets.open(path).use { stream -> stream.readBytes() }
    }

    private fun sha256(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val result = StringBuilder(digest.size * 2)
        for (value in digest) {
            val unsigned = value.toInt() and 0xff
            result.append(HEX[unsigned ushr 4])
            result.append(HEX[unsigned and 0x0f])
        }
        return result.toString()
    }

    private fun requireExactKeys(value: JSONObject, expected: Set<String>) {
        val keys = mutableSetOf<String>()
        val iterator = value.keys()
        while (iterator.hasNext()) keys.add(iterator.next())
        require(keys == expected)
    }

    private companion object {
        const val CATALOG_ASSET = "catalog.json"
        const val LAUNCHER_CATALOG_ASSET = "launcher-catalog.json"
        const val PACKAGE_MANIFEST = "arcane-app-package.json"
        const val CONTENT_MANIFEST = "arcane-app-content.json"
        const val MAX_APPLICATIONS = 256
        const val MAX_NAVIGATION_ENTRIES = 256
        const val MAX_PACKAGE_FILES = 8192
        const val MAX_CONTENT_FILES = 8192
        const val MAX_ASSET_PATH_LENGTH = 512
        const val PROTOCOL = "arcane/1"
        const val APP_FILE_PREFIX = "app/"
        const val HEX = "0123456789abcdef"
        val APPLICATION_ID = Regex("^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
        val ANDROID_PACKAGE = Regex("^os\\.arcane\\.app\\.[a-z][a-z0-9_]{0,62}$")
        val ASSET_PATH = Regex("^[A-Za-z0-9._/ -]+$")
        val CAPABILITY = Regex("^[a-z][a-z0-9]*(?:\\.[a-z][a-z0-9]*)+$")
        val SHA256 = Regex("^[a-f0-9]{64}$")
    }
}
