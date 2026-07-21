package os.arcane.host.android

import android.content.Context
import java.io.File
import java.io.InputStream
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.text.SimpleDateFormat
import java.util.Collections
import java.util.Date
import java.util.LinkedHashMap
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread
import org.json.JSONObject

internal class ArcaneAndroidTerminalProvider(context: Context) : ArcaneWebViewBridge.TerminalProvider {
    private val applicationContext = context.applicationContext
    private val rootDirectory = applicationContext.filesDir.canonicalFile
    private val sessions = Collections.synchronizedMap(LinkedHashMap<String, Session>())
    @Volatile
    private var eventSink: ((String) -> Unit)? = null

    private data class Session(
        val id: String,
        val process: Process,
        val shell: String,
        val cwd: String,
        val title: String,
        val createdAt: String,
        @Volatile var columns: Int,
        @Volatile var rows: Int,
        @Volatile var state: String,
        val outputBytes: AtomicLong = AtomicLong(0),
        val outputLimitReported: AtomicBoolean = AtomicBoolean(false)
    )

    override fun setEventSink(sink: ((String) -> Unit)?) {
        eventSink = sink
    }

    override fun start(parameters: AndroidBridgeProtocol.TerminalParameters): AndroidBridgeProtocol.TerminalSession {
        synchronized(sessions) {
            if (sessions.size >= GeneratedAndroidMethodContracts.TERMINAL_LIST_OUTPUT_MAX_SESSIONS) {
                throw ArcaneWebViewBridge.TerminalFailure(
                    "TERMINAL_SESSION_LIMIT",
                    "Arcane Terminal already has the maximum number of Android sessions."
                )
            }
        }
        val requestedShell = parameters.shell ?: "auto"
        if (requestedShell !in setOf("auto", "sh")) {
            throw ArcaneWebViewBridge.TerminalFailure(
                "TERMINAL_SHELL_UNAVAILABLE",
                "Android Arcane Terminal supports the application-sandbox sh shell."
            )
        }
        val cwd = resolveWorkingDirectory(parameters.cwd.orEmpty())
        val columns = parameters.columns ?: 120
        val rows = parameters.rows ?: 32
        val builder = ProcessBuilder("/system/bin/sh")
            .directory(cwd)
            .redirectErrorStream(false)
        val environment = builder.environment()
        environment.clear()
        environment["HOME"] = rootDirectory.path
        environment["TMPDIR"] = applicationContext.cacheDir.path
        environment["PATH"] = "/system/bin:/system/xbin"
        environment["TERM"] = "xterm-256color"
        environment["ARCANE_TERMINAL"] = "1"
        val process = try {
            builder.start()
        } catch (_: Exception) {
            throw ArcaneWebViewBridge.TerminalFailure(
                "TERMINAL_START_FAILED",
                "Android could not start the application-sandbox shell."
            )
        }
        val session = Session(
            id = "term-${UUID.randomUUID()}",
            process = process,
            shell = "sh",
            cwd = cwd.path,
            title = "Android shell",
            createdAt = timestamp(),
            columns = columns,
            rows = rows,
            state = "running"
        )
        sessions[session.id] = session
        forward(session, process.inputStream, "stdout")
        forward(session, process.errorStream, "stderr")
        thread(name = "arcane-terminal-exit-${session.id}", isDaemon = true) {
            val exitCode = try {
                process.waitFor()
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                null
            }
            session.state = if (session.state == "closed") "closed" else "exited"
            sessions.remove(session.id)
            if (exitCode != null) {
                emit(
                    "terminal.exit",
                    JSONObject()
                        .put("sessionId", session.id)
                        .put("exitCode", exitCode)
                        .put("signal", JSONObject.NULL)
                )
            }
        }
        return descriptor(session)
    }

    override fun list(): List<AndroidBridgeProtocol.TerminalSession> {
        synchronized(sessions) {
            return sessions.values.map(::descriptor)
        }
    }

    override fun write(sessionId: String, data: String): Int {
        val session = requireSession(sessionId)
        val bytes = data.toByteArray(StandardCharsets.UTF_8)
        if (bytes.isEmpty() || bytes.size > GeneratedAndroidMethodContracts.TERMINAL_WRITE_INPUT_MAX_DATA_BYTES) {
            throw ArcaneWebViewBridge.TerminalFailure("TERMINAL_DATA_INVALID", "Android rejected empty or oversized terminal input.")
        }
        try {
            session.process.outputStream.write(bytes)
            session.process.outputStream.flush()
        } catch (_: Exception) {
            throw ArcaneWebViewBridge.TerminalFailure("TERMINAL_INPUT_CLOSED", "That Android terminal session no longer accepts input.")
        }
        return bytes.size
    }

    override fun resize(sessionId: String, columns: Int, rows: Int) {
        val session = requireSession(sessionId)
        session.columns = columns
        session.rows = rows
    }

    override fun signal(sessionId: String, signal: String): Boolean {
        val session = requireSession(sessionId)
        return try {
            session.process.destroy()
            true
        } catch (_: Exception) {
            false
        }
    }

    override fun close(sessionId: String) {
        val session = requireSession(sessionId)
        session.state = "closed"
        try {
            session.process.outputStream.close()
        } catch (_: Exception) {
        }
        session.process.destroy()
    }

    override fun closeAll() {
        eventSink = null
        val snapshot = synchronized(sessions) { sessions.values.toList() }
        for (session in snapshot) {
            session.state = "closed"
            try {
                session.process.outputStream.close()
            } catch (_: Exception) {
            }
            try {
                session.process.destroy()
            } catch (_: Exception) {
            }
        }
        sessions.clear()
    }

    private fun forward(session: Session, stream: InputStream, streamName: String) {
        thread(name = "arcane-terminal-$streamName-${session.id}", isDaemon = true) {
            val reader = InputStreamReader(stream, StandardCharsets.UTF_8)
            val buffer = CharArray(4096)
            try {
                while (true) {
                    val count = reader.read(buffer)
                    if (count < 0) break
                    if (count == 0) continue
                    val data = String(buffer, 0, count)
                    val total = session.outputBytes.addAndGet(data.toByteArray(StandardCharsets.UTF_8).size.toLong())
                    if (total > MAX_SESSION_OUTPUT_BYTES) {
                        if (session.outputLimitReported.compareAndSet(false, true)) {
                            emit(
                                "terminal.error",
                                JSONObject()
                                    .put("sessionId", session.id)
                                    .put("message", "Android stopped this terminal session after its output limit was reached.")
                            )
                            session.process.destroy()
                        }
                        break
                    }
                    emit(
                        "terminal.output",
                        JSONObject()
                            .put("sessionId", session.id)
                            .put("stream", streamName)
                            .put("data", data)
                    )
                }
            } catch (_: Exception) {
                if (session.process.isAlive) {
                    emit(
                        "terminal.error",
                        JSONObject()
                            .put("sessionId", session.id)
                            .put("message", "Android could not read terminal $streamName output.")
                    )
                }
            }
        }
    }

    private fun requireSession(sessionId: String): Session {
        return sessions[sessionId]
            ?: throw ArcaneWebViewBridge.TerminalFailure("TERMINAL_SESSION_NOT_FOUND", "That Android terminal session is no longer running.")
    }

    private fun resolveWorkingDirectory(requested: String): File {
        val candidate = if (requested.isBlank()) rootDirectory else File(requested).canonicalFile
        val insideRoot = candidate == rootDirectory || candidate.path.startsWith(rootDirectory.path + File.separator)
        if (!insideRoot || !candidate.isDirectory) {
            throw ArcaneWebViewBridge.TerminalFailure(
                "TERMINAL_CWD_INVALID",
                "Android Terminal working directories must be existing folders inside this application's private files."
            )
        }
        return candidate
    }

    private fun descriptor(session: Session): AndroidBridgeProtocol.TerminalSession {
        return AndroidBridgeProtocol.TerminalSession(
            id = session.id,
            shell = session.shell,
            cwd = session.cwd,
            title = session.title,
            columns = session.columns,
            rows = session.rows,
            createdAt = session.createdAt,
            state = session.state
        )
    }

    private fun emit(event: String, data: JSONObject) {
        val encoded = try {
            AndroidBridgeProtocol.terminalEvent(event, data)
        } catch (_: Exception) {
            return
        }
        eventSink?.invoke(encoded)
    }

    private fun timestamp(): String {
        val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        formatter.timeZone = TimeZone.getTimeZone("UTC")
        return formatter.format(Date())
    }

    private companion object {
        const val MAX_SESSION_OUTPUT_BYTES = 1024L * 1024L
    }
}
