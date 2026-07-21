package os.arcane.host.android

import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.LinkedHashSet

internal object AndroidBridgeProtocol {
    private const val PROTOCOL = "arcane/1"
    private const val MAX_MESSAGE_BYTES = 1024 * 1024
    private const val MAX_REMEMBERED_REQUEST_IDS = 4096
    private val requestIdPattern = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    private val sentAtPattern = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$")
    private val applicationIdPattern = Regex("^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
    private val windowsReservedApplicationIdPattern = Regex("^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?$", RegexOption.IGNORE_CASE)
    private val applicationEntryPattern = Regex("^[A-Za-z0-9._/-]+$")

    internal data class Request(
        val id: String,
        val method: String,
        val externalUri: String?,
        val applicationId: String? = null,
        val terminal: TerminalParameters? = null
    )

    internal data class TerminalParameters(
        val sessionId: String? = null,
        val data: String? = null,
        val shell: String? = null,
        val cwd: String? = null,
        val columns: Int? = null,
        val rows: Int? = null,
        val signal: String? = null
    )

    internal data class TerminalSession(
        val id: String,
        val shell: String,
        val cwd: String,
        val title: String,
        val columns: Int,
        val rows: Int,
        val createdAt: String,
        val state: String
    )

    internal data class Status(
        val release: String,
        val architecture: String,
        val version: String,
        val rendererVersion: String?,
        val application: Application
    )

    internal data class Application(
        val id: String,
        val displayName: String,
        val type: String,
        val entry: String?,
        val version: String
    )

    internal class ReplayWindow {
        private val requestIds = LinkedHashSet<String>()

        @Synchronized
        internal fun remember(requestId: String): Boolean {
            if (!requestIds.add(requestId)) {
                return false
            }
            if (requestIds.size > MAX_REMEMBERED_REQUEST_IDS) {
                requestIds.remove(requestIds.first())
            }
            return true
        }
    }

    internal fun isOversized(encoded: String): Boolean {
        return encoded.toByteArray(StandardCharsets.UTF_8).size > MAX_MESSAGE_BYTES
    }

    internal fun parseRequest(encoded: String): Request? {
        val request = try {
            JSONObject(encoded)
        } catch (_: Exception) {
            return null
        }
        if (!hasExactKeys(request, setOf("protocol", "type", "id", "method", "parameters", "sentAt"))) {
            return null
        }
        val protocol = request.opt("protocol") as? String ?: return null
        val type = request.opt("type") as? String ?: return null
        if (protocol != PROTOCOL || type != "request") {
            return null
        }
        val id = request.opt("id") as? String ?: return null
        val method = request.opt("method") as? String ?: return null
        val sentAt = request.opt("sentAt") as? String ?: return null
        val parameters = request.opt("parameters") as? JSONObject ?: return null
        if (!requestIdPattern.matches(id) || method.isEmpty() || method.length > 128 || !sentAtPattern.matches(sentAt)) {
            return null
        }
        var externalUri: String? = null
        var applicationId: String? = null
        var terminal: TerminalParameters? = null
        if (method == GeneratedAndroidCapabilityRegistry.SYSTEM_PING_METHOD
            || method == GeneratedAndroidCapabilityRegistry.VERSION_CURRENT_METHOD
            || method == GeneratedAndroidCapabilityRegistry.APP_CURRENT_METHOD
            || method == GeneratedAndroidCapabilityRegistry.USER_CURRENT_METHOD
            || method == GeneratedAndroidCapabilityRegistry.APPS_LIST_METHOD
            || method == GeneratedAndroidCapabilityRegistry.PLATFORM_STATUS_METHOD
            || method == GeneratedAndroidCapabilityRegistry.NETWORK_STATUS_METHOD) {
            if (parameters.keys().hasNext()) return null
        } else if (method == GeneratedAndroidCapabilityRegistry.APPS_LAUNCH_METHOD) {
            if (!hasExactKeys(parameters, setOf("id"))) return null
            val candidate = parameters.opt("id") as? String ?: return null
            if (!isCanonicalLaunchApplicationId(candidate)) return null
            applicationId = candidate
        } else if (method == GeneratedAndroidCapabilityRegistry.EXTERNAL_OPEN_METHOD) {
            if (!hasExactKeys(parameters, setOf("uri"))) return null
            val candidate = parameters.opt("uri") as? String ?: return null
            externalUri = canonicalMailtoUri(candidate) ?: return null
        } else if (method == GeneratedAndroidCapabilityRegistry.TERMINAL_START_METHOD) {
            if (!hasExactKeys(parameters, setOf("shell", "cwd", "columns", "rows"))) return null
            val shell = parameters.opt("shell") as? String ?: return null
            val cwd = parameters.opt("cwd") as? String ?: return null
            val columns = exactInt(parameters.opt("columns")) ?: return null
            val rows = exactInt(parameters.opt("rows")) ?: return null
            if (shell.isEmpty() || shell.length > GeneratedAndroidMethodContracts.TERMINAL_START_INPUT_MAX_SHELL_LENGTH
                || cwd.length > GeneratedAndroidMethodContracts.TERMINAL_START_INPUT_MAX_CWD_LENGTH
                || columns !in GeneratedAndroidMethodContracts.TERMINAL_START_INPUT_MIN_COLUMNS..GeneratedAndroidMethodContracts.TERMINAL_START_INPUT_MAX_COLUMNS
                || rows !in GeneratedAndroidMethodContracts.TERMINAL_START_INPUT_MIN_ROWS..GeneratedAndroidMethodContracts.TERMINAL_START_INPUT_MAX_ROWS) return null
            terminal = TerminalParameters(shell = shell, cwd = cwd, columns = columns, rows = rows)
        } else if (method == GeneratedAndroidCapabilityRegistry.TERMINAL_LIST_METHOD) {
            if (parameters.keys().hasNext()) return null
            terminal = TerminalParameters()
        } else if (method == GeneratedAndroidCapabilityRegistry.TERMINAL_WRITE_METHOD) {
            if (!hasExactKeys(parameters, setOf("sessionId", "data"))) return null
            val sessionId = validTerminalSessionId(parameters.opt("sessionId") as? String ?: return null) ?: return null
            val data = parameters.opt("data") as? String ?: return null
            val bytes = data.toByteArray(StandardCharsets.UTF_8).size
            if (bytes !in 1..GeneratedAndroidMethodContracts.TERMINAL_WRITE_INPUT_MAX_DATA_BYTES) return null
            terminal = TerminalParameters(sessionId = sessionId, data = data)
        } else if (method == GeneratedAndroidCapabilityRegistry.TERMINAL_RESIZE_METHOD) {
            if (!hasExactKeys(parameters, setOf("sessionId", "columns", "rows"))) return null
            val sessionId = validTerminalSessionId(parameters.opt("sessionId") as? String ?: return null) ?: return null
            val columns = exactInt(parameters.opt("columns")) ?: return null
            val rows = exactInt(parameters.opt("rows")) ?: return null
            if (columns !in GeneratedAndroidMethodContracts.TERMINAL_RESIZE_INPUT_MIN_COLUMNS..GeneratedAndroidMethodContracts.TERMINAL_RESIZE_INPUT_MAX_COLUMNS
                || rows !in GeneratedAndroidMethodContracts.TERMINAL_RESIZE_INPUT_MIN_ROWS..GeneratedAndroidMethodContracts.TERMINAL_RESIZE_INPUT_MAX_ROWS) return null
            terminal = TerminalParameters(sessionId = sessionId, columns = columns, rows = rows)
        } else if (method == GeneratedAndroidCapabilityRegistry.TERMINAL_SIGNAL_METHOD) {
            if (!hasExactKeys(parameters, setOf("sessionId", "signal"))) return null
            val sessionId = validTerminalSessionId(parameters.opt("sessionId") as? String ?: return null) ?: return null
            val signal = parameters.opt("signal") as? String ?: return null
            if (signal !in setOf("interrupt", "terminate")) return null
            terminal = TerminalParameters(sessionId = sessionId, signal = signal)
        } else if (method == GeneratedAndroidCapabilityRegistry.TERMINAL_CLOSE_METHOD) {
            if (!hasExactKeys(parameters, setOf("sessionId"))) return null
            val sessionId = validTerminalSessionId(parameters.opt("sessionId") as? String ?: return null) ?: return null
            terminal = TerminalParameters(sessionId = sessionId)
        } else {
            if (GeneratedAndroidCapabilityRegistry.isSupported(method)) return null
        }
        return Request(id, method, externalUri, applicationId, terminal)
    }

    internal fun terminalStartResponse(request: Request, session: TerminalSession): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.TERMINAL_START_METHOD || !isValidTerminalSession(session)) {
            return errorResponse(request.id, "METHOD_CONTRACT_OUTPUT_INVALID", "Android returned an invalid terminal session.")
        }
        return successResponse(request.id, terminalSessionJson(session, includeState = false))
    }

    internal fun terminalListResponse(request: Request, sessions: List<TerminalSession>): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.TERMINAL_LIST_METHOD
            || sessions.size > GeneratedAndroidMethodContracts.TERMINAL_LIST_OUTPUT_MAX_SESSIONS
            || sessions.any { !isValidTerminalSession(it) }) {
            return errorResponse(request.id, "METHOD_CONTRACT_OUTPUT_INVALID", "Android returned an invalid terminal session list.")
        }
        return successResponse(
            request.id,
            JSONObject().put("sessions", JSONArray().apply {
                for (session in sessions) put(terminalSessionJson(session, includeState = true))
            })
        )
    }

    internal fun terminalWriteResponse(request: Request, sessionId: String, bytes: Int): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.TERMINAL_WRITE_METHOD
            || validTerminalSessionId(sessionId) == null
            || bytes !in 1..GeneratedAndroidMethodContracts.TERMINAL_WRITE_OUTPUT_MAX_DATA_BYTES) {
            return errorResponse(request.id, "METHOD_CONTRACT_OUTPUT_INVALID", "Android returned an invalid terminal write result.")
        }
        return successResponse(request.id, JSONObject().put("sessionId", sessionId).put("accepted", true).put("bytes", bytes))
    }

    internal fun terminalResizeResponse(request: Request, sessionId: String, columns: Int, rows: Int): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.TERMINAL_RESIZE_METHOD
            || validTerminalSessionId(sessionId) == null
            || columns !in GeneratedAndroidMethodContracts.TERMINAL_RESIZE_OUTPUT_MIN_COLUMNS..GeneratedAndroidMethodContracts.TERMINAL_RESIZE_OUTPUT_MAX_COLUMNS
            || rows !in GeneratedAndroidMethodContracts.TERMINAL_RESIZE_OUTPUT_MIN_ROWS..GeneratedAndroidMethodContracts.TERMINAL_RESIZE_OUTPUT_MAX_ROWS) {
            return errorResponse(request.id, "METHOD_CONTRACT_OUTPUT_INVALID", "Android returned an invalid terminal resize result.")
        }
        return successResponse(request.id, JSONObject().put("sessionId", sessionId).put("columns", columns).put("rows", rows).put("accepted", true).put("emulated", true))
    }

    internal fun terminalSignalResponse(request: Request, sessionId: String, signal: String, accepted: Boolean): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.TERMINAL_SIGNAL_METHOD
            || validTerminalSessionId(sessionId) == null || signal !in setOf("interrupt", "terminate")) {
            return errorResponse(request.id, "METHOD_CONTRACT_OUTPUT_INVALID", "Android returned an invalid terminal signal result.")
        }
        return successResponse(request.id, JSONObject().put("sessionId", sessionId).put("signal", signal).put("accepted", accepted))
    }

    internal fun terminalCloseResponse(request: Request, sessionId: String): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.TERMINAL_CLOSE_METHOD || validTerminalSessionId(sessionId) == null) {
            return errorResponse(request.id, "METHOD_CONTRACT_OUTPUT_INVALID", "Android returned an invalid terminal close result.")
        }
        return successResponse(request.id, JSONObject().put("sessionId", sessionId).put("accepted", true))
    }

    internal fun terminalEvent(event: String, data: JSONObject): String {
        require(event in setOf("terminal.output", "terminal.exit", "terminal.error"))
        return JSONObject()
            .put("protocol", PROTOCOL)
            .put("type", "event")
            .put("event", event)
            .put("data", data)
            .toString()
    }

    internal fun applicationLaunchResponse(request: Request, applicationId: String): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.APPS_LAUNCH_METHOD
            || request.applicationId != applicationId
            || !isCanonicalLaunchApplicationId(applicationId)) {
            return errorResponse(request.id, "METHOD_CONTRACT_OUTPUT_INVALID", "Android returned an invalid application launch result.")
        }
        return successResponse(
            request.id,
            JSONObject()
                .put("id", applicationId)
                .put("accepted", true)
        )
    }

    internal fun applicationCatalogResponse(
        request: Request,
        catalog: ArcaneWebViewBridge.ApplicationCatalog
    ): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.APPS_LIST_METHOD
            || catalog.applications.size > 256) {
            return errorResponse(request.id, "APPLICATION_CATALOG_UNVERIFIED", "Android returned an unverified application catalog.")
        }
        val applications = JSONArray()
        val identifiers = mutableSetOf<String>()
        var previousOrder = -1
        for (application in catalog.applications) {
            if (application.verified != catalog.verified
                || !applicationIdPattern.matches(application.id)
                || !identifiers.add(application.id)
                || application.displayName.isEmpty()
                || application.displayName.length > 80
                || application.description.length > 240
                || application.version != GeneratedAndroidApplicationRegistry.BUNDLE_VERSION
                || application.order <= previousOrder
                || !isSafeCatalogIconUrl(application.iconUrl, application.id)) {
                return errorResponse(request.id, "APPLICATION_CATALOG_UNVERIFIED", "Android returned an unverified application catalog.")
            }
            applications.put(
                JSONObject()
                    .put("id", application.id)
                    .put("displayName", application.displayName)
                    .put("description", application.description)
                    .put("iconUrl", application.iconUrl)
                    .put("version", application.version)
                    .put("order", application.order)
                    .put("verified", application.verified)
            )
            previousOrder = application.order
        }
        val hasNoTrustEvidence = catalog.publisherTrustSource == null && catalog.revocationStatus == null
        if (catalog.verified && (catalog.securityMode != "unsigned-local-test" || !hasNoTrustEvidence)) {
            return errorResponse(request.id, "APPLICATION_CATALOG_UNVERIFIED", "Android returned invalid application catalog security evidence.")
        }
        if (!catalog.verified && (catalog.securityMode != "unverified" || !hasNoTrustEvidence)) {
            return errorResponse(request.id, "APPLICATION_CATALOG_UNVERIFIED", "Android returned invalid application catalog security evidence.")
        }
        return successResponse(
            request.id,
            JSONObject()
                .put("verified", catalog.verified)
                .put("securityMode", catalog.securityMode)
                .put("publisherTrustSource", catalog.publisherTrustSource ?: JSONObject.NULL)
                .put("revocationStatus", catalog.revocationStatus ?: JSONObject.NULL)
                .put("applications", applications)
        )
    }

    internal fun systemPingResponse(request: Request): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.SYSTEM_PING_METHOD) {
            return errorResponse(
                request.id,
                "ANDROID_CAPABILITY_UNSUPPORTED",
                "This Arcane capability is not available from the Android launcher."
            )
        }
        return JSONObject()
            .put("protocol", PROTOCOL)
            .put("type", "response")
            .put("id", request.id)
            .put("ok", true)
            .put("result", JSONObject().put("ok", true))
            .toString()
    }

    internal fun versionCurrentResponse(request: Request, version: String): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.VERSION_CURRENT_METHOD
            || !isValidVersion(version)) {
            return errorResponse(request.id, "METHOD_CONTRACT_OUTPUT_INVALID", "Android returned an invalid Arcane version.")
        }
        return successResponse(request.id, version)
    }

    internal fun appCurrentResponse(request: Request, application: Application): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.APP_CURRENT_METHOD) {
            return errorResponse(request.id, "ANDROID_CAPABILITY_UNSUPPORTED", "This Arcane capability is not available from the Android launcher.")
        }
        val validated = validatedApplication(application)
            ?: return errorResponse(request.id, "METHOD_CONTRACT_OUTPUT_INVALID", "Android returned an invalid Arcane application identity.")
        return successResponse(request.id, applicationJson(validated))
    }

    internal fun userCurrentResponse(request: Request, identity: ArcaneWebViewBridge.UserIdentity): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.USER_CURRENT_METHOD
            || !isValidUserIdentity(identity)) {
            return errorResponse(request.id, "METHOD_CONTRACT_OUTPUT_INVALID", "Android returned an invalid Arcane user identity.")
        }
        val result = JSONObject()
            .put("identityKind", identity.identityKind)
            .put("username", JSONObject.NULL)
            .put("accountName", JSONObject.NULL)
            .put("displayName", identity.displayName)
            .put("source", identity.source)
        return successResponse(request.id, result)
    }

    internal fun statusResponseFor(
        request: Request,
        status: Status,
        grants: List<String>,
        methods: List<String>
    ): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.PLATFORM_STATUS_METHOD) {
            return errorResponse(
                request.id,
                "ANDROID_CAPABILITY_UNSUPPORTED",
                "This Arcane capability is not available from the Android launcher."
            )
        }
        val application = validatedApplication(status.application)
            ?: return errorResponse(
                request.id,
                "ANDROID_APPLICATION_IDENTITY_INVALID",
                "The Android host supplied an invalid Arcane application identity."
            )
        if (!isValidStatusText(status.release)
            || !isValidStatusText(status.architecture)
            || !isValidStatusText(status.version)
            || status.version != application.version
            || (status.rendererVersion != null && !isValidStatusText(status.rendererVersion))
            || !isValidSortedStringList(grants)
            || !isValidSortedStringList(methods)) {
            return errorResponse(
                request.id,
                "METHOD_CONTRACT_OUTPUT_INVALID",
                "Android returned platform status that did not match the Arcane method contract."
            )
        }
        return statusSuccessResponse(request.id, status, application, grants, methods)
    }

    internal fun externalOpenResponse(request: Request, uri: String): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.EXTERNAL_OPEN_METHOD) {
            return errorResponse(
                request.id,
                "ANDROID_CAPABILITY_UNSUPPORTED",
                "This Arcane capability is not available from the Android launcher."
            )
        }
        val canonicalUri = canonicalMailtoUri(uri)
        if (canonicalUri == null || canonicalUri.length > GeneratedAndroidMethodContracts.EXTERNAL_OPEN_OUTPUT_MAX_URI_LENGTH) {
            return errorResponse(
                request.id,
                "METHOD_CONTRACT_OUTPUT_INVALID",
                "Android returned an external-open result that did not match the Arcane method contract."
            )
        }
        return JSONObject()
            .put("protocol", PROTOCOL)
            .put("type", "response")
            .put("id", request.id)
            .put("ok", true)
            .put(
                "result",
                JSONObject()
                    .put("opened", true)
                    .put("uri", canonicalUri)
            )
            .toString()
    }

    internal fun networkStatusResponse(request: Request, online: Boolean, interfaceCount: Int): String {
        if (request.method != GeneratedAndroidCapabilityRegistry.NETWORK_STATUS_METHOD
            || interfaceCount < 0
            || interfaceCount > GeneratedAndroidMethodContracts.NETWORK_STATUS_OUTPUT_MAX_INTERFACE_COUNT
            || online != (interfaceCount > 0)) {
            return errorResponse(
                request.id,
                "NETWORK_STATUS_UNAVAILABLE",
                "Android did not return a valid network status."
            )
        }
        return JSONObject()
            .put("protocol", PROTOCOL)
            .put("type", "response")
            .put("id", request.id)
            .put("ok", true)
            .put(
                "result",
                JSONObject()
                    .put("online", online)
                    .put("interfaceCount", interfaceCount)
            )
            .toString()
    }

    internal fun errorResponse(requestId: String, code: String, message: String): String {
        return JSONObject()
            .put("protocol", PROTOCOL)
            .put("type", "response")
            .put("id", requestId)
            .put("ok", false)
            .put(
                "error",
                JSONObject()
                    .put("code", code)
                    .put("message", message)
                    .put("resolution", "Use a supported Arcane Android launcher capability.")
            )
            .toString()
    }

    private fun hasExactKeys(value: JSONObject, expected: Set<String>): Boolean {
        val actual = mutableSetOf<String>()
        val keys = value.keys()
        while (keys.hasNext()) {
            actual.add(keys.next())
        }
        return actual == expected
    }

    private fun exactInt(value: Any?): Int? {
        val number = value as? Number ?: return null
        val integer = number.toInt()
        return if (number.toDouble() == integer.toDouble()) integer else null
    }

    private fun validTerminalSessionId(value: String): String? {
        return if (value.length <= GeneratedAndroidMethodContracts.TERMINAL_START_OUTPUT_MAX_SESSION_ID_LENGTH
            && requestIdPattern.matches(value)) value else null
    }

    private fun isValidTerminalSession(session: TerminalSession): Boolean {
        return validTerminalSessionId(session.id) != null
            && session.shell.isNotEmpty()
            && session.shell.length <= GeneratedAndroidMethodContracts.TERMINAL_START_OUTPUT_MAX_SHELL_LENGTH
            && session.cwd.isNotEmpty()
            && session.cwd.length <= GeneratedAndroidMethodContracts.TERMINAL_START_OUTPUT_MAX_CWD_LENGTH
            && session.title.isNotEmpty()
            && session.title.length <= GeneratedAndroidMethodContracts.TERMINAL_START_OUTPUT_MAX_TITLE_LENGTH
            && session.createdAt.isNotEmpty()
            && session.createdAt.length <= GeneratedAndroidMethodContracts.TERMINAL_START_OUTPUT_MAX_TIMESTAMP_LENGTH
            && session.columns in GeneratedAndroidMethodContracts.TERMINAL_RESIZE_OUTPUT_MIN_COLUMNS..GeneratedAndroidMethodContracts.TERMINAL_RESIZE_OUTPUT_MAX_COLUMNS
            && session.rows in GeneratedAndroidMethodContracts.TERMINAL_RESIZE_OUTPUT_MIN_ROWS..GeneratedAndroidMethodContracts.TERMINAL_RESIZE_OUTPUT_MAX_ROWS
            && session.state in setOf("starting", "running", "exited", "closed")
    }

    private fun terminalSessionJson(session: TerminalSession, includeState: Boolean): JSONObject {
        val result = JSONObject()
            .put("id", session.id)
            .put("shell", session.shell)
            .put("cwd", session.cwd)
            .put("columns", session.columns)
            .put("rows", session.rows)
            .put("createdAt", session.createdAt)
        if (includeState) result.put("state", session.state) else result.put("title", session.title)
        return result
    }

    private fun isSafeCatalogIconUrl(value: String, applicationId: String): Boolean {
        val packagedIcon = value.startsWith("/arcane/$applicationId/app/")
        val launcherIcon = value.startsWith("/arcane/launcher-icons/$applicationId.")
        if ((!packagedIcon && !launcherIcon)
            || value.contains('\\')
            || value.contains('%')
            || value.contains('?')
            || value.contains('#')) {
            return false
        }
        for (segment in value.split('/')) {
            if (segment == "." || segment == "..") return false
        }
        return true
    }

    internal fun isValidApplication(application: Application): Boolean {
        return validatedApplication(application) != null
    }

    internal fun isValidUserIdentity(identity: ArcaneWebViewBridge.UserIdentity): Boolean {
        return identity.identityKind == "local-session"
            && identity.username == null
            && identity.accountName == null
            && identity.source == "android"
            && isValidStatusText(identity.displayName)
            && identity.displayName.length <= GeneratedAndroidMethodContracts.USER_CURRENT_OUTPUT_MAX_DISPLAY_NAME_LENGTH
    }

    private fun validatedApplication(application: Application): Application? {
        if (!applicationIdPattern.matches(application.id) || application.id.length > GeneratedAndroidMethodContracts.APP_CURRENT_OUTPUT_MAX_APPLICATION_ID_LENGTH) return null
        if (!isValidStatusText(application.displayName) || application.displayName.length > GeneratedAndroidMethodContracts.APP_CURRENT_OUTPUT_MAX_DISPLAY_NAME_LENGTH) return null
        if (application.type !in setOf("app", "shell", "provisioner")) return null
        if (!isValidVersion(application.version) || application.version.length > GeneratedAndroidMethodContracts.APP_CURRENT_OUTPUT_MAX_APPLICATION_VERSION_LENGTH) return null
        val entry = application.entry
        if (entry != null) {
            if (entry.isEmpty() || entry.length > GeneratedAndroidMethodContracts.APP_CURRENT_OUTPUT_MAX_APPLICATION_ENTRY_LENGTH || entry.startsWith('/') || !applicationEntryPattern.matches(entry)) return null
            for (segment in entry.split('/')) {
                if (segment == "." || segment == ".." || segment.isEmpty()) return null
            }
        }
        return application
    }

    private fun isValidVersion(version: String): Boolean {
        return isValidStatusText(version)
            && version.length <= GeneratedAndroidMethodContracts.VERSION_CURRENT_OUTPUT_MAX_LENGTH
            && version == GeneratedAndroidApplicationRegistry.BUNDLE_VERSION
    }

    private fun applicationJson(application: Application): JSONObject {
        return JSONObject()
            .put("id", application.id)
            .put("displayName", application.displayName)
            .put("type", application.type)
            .put("entry", application.entry ?: JSONObject.NULL)
            .put("version", application.version)
            .put("securityMode", "unverified")
            .put("publisherTrustSource", JSONObject.NULL)
            .put("revocationStatus", JSONObject.NULL)
    }

    private fun successResponse(requestId: String, result: Any): String {
        return JSONObject()
            .put("protocol", PROTOCOL)
            .put("type", "response")
            .put("id", requestId)
            .put("ok", true)
            .put("result", result)
            .toString()
    }

    private fun validatedExternalUriInput(value: String): String? {
        if (value.isEmpty() || value.length > GeneratedAndroidMethodContracts.EXTERNAL_OPEN_INPUT_MAX_URI_LENGTH || value != value.trim()) return null
        for (character in value) {
            if (character.code < 33 || character.code > 126 || character == '\\' || character == '#') return null
        }
        var index = 0
        while (index < value.length) {
            if (value[index] == '%') {
                if (index + 2 >= value.length) return null
                val encoded = value.substring(index + 1, index + 3).toIntOrNull(16) ?: return null
                if (encoded <= 31 || encoded in 127..159) return null
                index += 2
            }
            index += 1
        }
        return value
    }

    internal fun canonicalMailtoUri(value: String): String? {
        val validated = validatedExternalUriInput(value) ?: return null
        val separator = validated.indexOf(':')
        if (separator <= 0 || separator == validated.lastIndex) return null
        val scheme = validated.substring(0, separator)
        if (!scheme.equals(GeneratedAndroidMethodContracts.EXTERNAL_OPEN_INPUT_SCHEME, ignoreCase = true)) return null
        return GeneratedAndroidMethodContracts.EXTERNAL_OPEN_INPUT_SCHEME + validated.substring(separator)
    }

    private fun isCanonicalLaunchApplicationId(value: String): Boolean {
        return value.length <= 64
            && applicationIdPattern.matches(value)
            && value !in setOf("provisioner", "shell")
            && !windowsReservedApplicationIdPattern.matches(value)
    }

    private fun statusSuccessResponse(
        requestId: String,
        status: Status,
        application: Application,
        grants: List<String>,
        methods: List<String>
    ): String {
        val result = JSONObject()
            .put("platform", "android")
            .put("rawPlatform", "android")
            .put("displayName", "Android")
            .put("release", status.release)
            .put("architecture", status.architecture)
            .put("desktop", JSONObject.NULL)
            .put("sessionType", "android")
            .put("simulated", false)
            .put("application", application.id)
            .put("version", status.version)
            .put("protocol", PROTOCOL)
            .put("adapter", "android-webview")
            .put(
                "execution",
                JSONObject()
                    .put("hostPlatform", "android")
                    .put("effectivePlatform", "android")
                    .put("simulation", false)
                    .put("evidenceClass", "application-host")
            )
            .put(
                "permissions",
                JSONObject()
                    .put("elevated", false)
                    .put("level", "application-sandbox")
                    .put("canElevate", false)
                    .put("mechanism", JSONObject.NULL)
                    .put("detectedBy", "android-application-sandbox")
                    .put("probes", JSONArray())
            )
            .put(
                "capabilities",
                JSONObject()
                    .put(
                        "app",
                        applicationJson(application)
                    )
                    .put("grants", JSONArray(grants))
                    .put("methods", JSONArray(methods))
            )
            .put(
                "renderer",
                JSONObject()
                    .put("id", "android-webview")
                    .put("available", true)
                    .put("version", status.rendererVersion ?: JSONObject.NULL)
                    .put("adapter", "androidx-webkit")
            )
        return JSONObject()
            .put("protocol", PROTOCOL)
            .put("type", "response")
            .put("id", requestId)
            .put("ok", true)
            .put("result", result)
            .toString()
    }

    private fun isValidStatusText(value: String): Boolean {
        if (value.isEmpty() || value.length > GeneratedAndroidMethodContracts.PLATFORM_STATUS_OUTPUT_MAX_STATUS_STRING_LENGTH) return false
        for (character in value) {
            if (character.code <= 31
                || character.code in 127..159
                || character.code == 0x2028
                || character.code == 0x2029
                || character.code in 0x202a..0x202e
                || character.code in 0x2066..0x2069) return false
        }
        return true
    }

    private fun isValidSortedStringList(value: List<String>): Boolean {
        if (value.size > GeneratedAndroidMethodContracts.PLATFORM_STATUS_OUTPUT_MAX_LIST_ITEMS) return false
        var previous: String? = null
        for (entry in value) {
            if (!isValidStatusText(entry) || entry == previous) return false
            if (previous != null && previous > entry) return false
            previous = entry
        }
        return true
    }
}
