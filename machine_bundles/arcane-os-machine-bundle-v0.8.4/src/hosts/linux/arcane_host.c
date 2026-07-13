#include <gtk/gtk.h>
#include <webkit/webkit.h>
#include <jsc/jsc.h>
#include <gio/gio.h>
#include <glib.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>
#include <stdio.h>

#ifndef ARCANE_APP
#define ARCANE_APP "provisioner"
#endif

#define ARCANE_PROTOCOL_MAX (16 * 1024 * 1024)

typedef struct {
  GtkApplication *application;
  GtkWindow *window;
  WebKitWebView *web_view;
  GSubprocess *core;
  GInputStream *core_stdout;
  GInputStream *core_stderr;
  GOutputStream *core_stdin;
  GMutex write_mutex;
  gchar *bundle_root;
  gchar *app_uri;
  gboolean web_ready;
  GQueue *pending_messages;
  gchar **host_argv;
} ArcaneHost;

typedef struct {
  ArcaneHost *host;
  gchar *json;
} Delivery;

static gchar *json_string(const gchar *value) {
  GString *out = g_string_new("\"");
  for (const gchar *p = value ? value : ""; *p; ++p) {
    switch (*p) {
      case '\\': g_string_append(out, "\\\\"); break;
      case '"': g_string_append(out, "\\\""); break;
      case '\n': g_string_append(out, "\\n"); break;
      case '\r': g_string_append(out, "\\r"); break;
      case '\t': g_string_append(out, "\\t"); break;
      default: g_string_append_c(out, *p); break;
    }
  }
  g_string_append_c(out, '"');
  return g_string_free(out, FALSE);
}

static gboolean deliver_on_main(gpointer data) {
  Delivery *delivery = data;
  ArcaneHost *host = delivery->host;
  if (host->web_ready && host->web_view) {
    gchar *script = g_strdup_printf("window.__arcaneReceive(%s);", delivery->json);
    webkit_web_view_evaluate_javascript(host->web_view, script, -1, NULL, "arcane-native", NULL, NULL, NULL);
    g_free(script);
  } else {
    g_queue_push_tail(host->pending_messages, g_strdup(delivery->json));
  }
  g_free(delivery->json);
  g_free(delivery);
  return G_SOURCE_REMOVE;
}

static void queue_delivery(ArcaneHost *host, const gchar *json) {
  Delivery *delivery = g_new0(Delivery, 1);
  delivery->host = host;
  delivery->json = g_strdup(json);
  g_idle_add(deliver_on_main, delivery);
}

static gboolean read_exact(GInputStream *stream, guint8 *buffer, gsize length, GError **error) {
  gsize read = 0;
  return g_input_stream_read_all(stream, buffer, length, &read, NULL, error) && read == length;
}

static gchar *read_frame(GInputStream *stream, GError **error) {
  GByteArray *header = g_byte_array_new();
  const guint8 marker[] = { 13, 10, 13, 10 };
  guint matched = 0;
  while (TRUE) {
    guint8 byte = 0;
    gssize count = g_input_stream_read(stream, &byte, 1, NULL, error);
    if (count == 0) { g_byte_array_unref(header); return NULL; }
    if (count < 0) { g_byte_array_unref(header); return NULL; }
    g_byte_array_append(header, &byte, 1);
    if (byte == marker[matched]) matched++; else matched = byte == marker[0] ? 1 : 0;
    if (matched == 4) break;
    if (header->len > 65536) {
      g_set_error(error, G_IO_ERROR, G_IO_ERROR_INVALID_DATA, "Arcane IPC header exceeded the allowed size.");
      g_byte_array_unref(header);
      return NULL;
    }
  }
  gchar *header_text = g_strndup((const gchar *)header->data, header->len);
  g_byte_array_unref(header);
  GRegex *regex = g_regex_new("Content-Length:[[:space:]]*([0-9]+)", G_REGEX_CASELESS, 0, NULL);
  GMatchInfo *match = NULL;
  guint64 length = 0;
  if (g_regex_match(regex, header_text, 0, &match)) {
    gchar *number = g_match_info_fetch(match, 1);
    length = g_ascii_strtoull(number, NULL, 10);
    g_free(number);
  }
  g_match_info_free(match);
  g_regex_unref(regex);
  g_free(header_text);
  if (!length || length > ARCANE_PROTOCOL_MAX) {
    g_set_error(error, G_IO_ERROR, G_IO_ERROR_INVALID_DATA, "Arcane IPC frame had an invalid Content-Length.");
    return NULL;
  }
  guint8 *body = g_malloc(length + 1);
  if (!read_exact(stream, body, length, error)) { g_free(body); return NULL; }
  body[length] = 0;
  return (gchar *)body;
}

static gpointer read_core_thread(gpointer data) {
  ArcaneHost *host = data;
  GError *error = NULL;
  while (TRUE) {
    gchar *json = read_frame(host->core_stdout, &error);
    if (!json) break;
    queue_delivery(host, json);
    g_free(json);
  }
  if (error) {
    gchar *message = json_string(error->message);
    gchar *event = g_strdup_printf("{\"protocol\":\"arcane/1\",\"type\":\"event\",\"event\":\"core.error\",\"data\":{\"code\":\"IPC_READ_FAILED\",\"message\":%s}}", message);
    queue_delivery(host, event);
    g_free(event);
    g_free(message);
    g_error_free(error);
  }
  return NULL;
}


static gpointer read_core_errors_thread(gpointer data) {
  ArcaneHost *host = data;
  GDataInputStream *input = g_data_input_stream_new(host->core_stderr);
  gchar *state_dir = g_build_filename(g_get_user_data_dir(), "arcane-os", "logs", NULL);
  g_mkdir_with_parents(state_dir, 0700);
  gchar *log_path = g_build_filename(state_dir, g_strcmp0(ARCANE_APP, "shell") == 0 ? "shell-core.log" : "provisioner-core.log", NULL);
  FILE *log_file = fopen(log_path, "a");
  GError *error = NULL;
  while (TRUE) {
    gsize length = 0;
    gchar *line = g_data_input_stream_read_line(input, &length, NULL, &error);
    if (!line) break;
    if (log_file) {
      GDateTime *now = g_date_time_new_now_utc();
      gchar *timestamp = g_date_time_format(now, "%FT%TZ");
      fprintf(log_file, "%s %s\n", timestamp, line);
      fflush(log_file);
      g_free(timestamp);
      g_date_time_unref(now);
    }
    g_free(line);
  }
  if (log_file) fclose(log_file);
  if (error) g_error_free(error);
  g_object_unref(input);
  g_free(log_path); g_free(state_dir);
  return NULL;
}

static gboolean send_to_core(ArcaneHost *host, const gchar *json, GError **error) {
  gsize body_length = strlen(json);
  gchar *header = g_strdup_printf("Content-Length: %" G_GSIZE_FORMAT "\r\n\r\n", body_length);
  g_mutex_lock(&host->write_mutex);
  gsize wrote = 0;
  gboolean ok = g_output_stream_write_all(host->core_stdin, header, strlen(header), &wrote, NULL, error)
    && g_output_stream_write_all(host->core_stdin, json, body_length, &wrote, NULL, error)
    && g_output_stream_flush(host->core_stdin, NULL, error);
  g_mutex_unlock(&host->write_mutex);
  g_free(header);
  return ok;
}

static gboolean on_script_message(WebKitUserContentManager *manager,
                                  JSCValue *value,
                                  WebKitScriptMessageReply *reply,
                                  gpointer user_data) {
  (void)manager;
  ArcaneHost *host = user_data;
  gchar *request = jsc_value_to_string(value);
  GError *error = NULL;
  gboolean accepted = send_to_core(host, request, &error);
  JSCContext *context = jsc_value_get_context(value);
  gchar *error_json = error ? json_string(error->message) : NULL;
  gchar *acknowledgement = accepted
    ? g_strdup("{\"accepted\":true}")
    : g_strdup_printf("{\"accepted\":false,\"error\":{\"code\":\"NATIVE_BRIDGE_WRITE_FAILED\",\"message\":%s}}", error_json);
  JSCValue *reply_value = jsc_value_new_string(context, acknowledgement);
  webkit_script_message_reply_return_value(reply, reply_value);
  g_object_unref(reply_value);
  g_free(error_json);
  g_free(acknowledgement);
  g_free(request);
  if (error) g_error_free(error);
  return TRUE;
}

static gchar *executable_directory(void) {
  gchar buffer[PATH_MAX + 1];
  ssize_t count = readlink("/proc/self/exe", buffer, PATH_MAX);
  if (count <= 0) return g_get_current_dir();
  buffer[count] = 0;
  return g_path_get_dirname(buffer);
}

static gchar *locate_bundle_root(void) {
  gchar *exe_dir = executable_directory();
  gchar *parent = g_path_get_dirname(exe_dir);
  gchar *cwd = g_get_current_dir();
  const gchar *env = g_getenv("ARCANE_BUNDLE_ROOT");
  gchar *candidates[] = { (gchar *)env, parent, exe_dir, cwd, NULL };
  for (guint index = 0; candidates[index]; index++) {
    gchar *manifest = g_build_filename(candidates[index], "arcane-bundle.json", NULL);
    gchar *app = g_build_filename(candidates[index], "app", NULL);
    gchar *dist_app = g_build_filename(candidates[index], "dist", "app", NULL);
    gboolean match = g_file_test(manifest, G_FILE_TEST_IS_REGULAR)
      && (g_file_test(app, G_FILE_TEST_IS_DIR) || g_file_test(dist_app, G_FILE_TEST_IS_DIR));
    g_free(manifest); g_free(app); g_free(dist_app);
    if (match) {
      gchar *result = g_canonicalize_filename(candidates[index], NULL);
      g_free(exe_dir); g_free(parent); g_free(cwd);
      return result;
    }
  }
  g_free(exe_dir); g_free(parent); g_free(cwd);
  return NULL;
}

static gboolean arg_allowed_for_core(const gchar *arg) {
  return g_strcmp0(arg, "--allow-source-install") == 0;
}

static gboolean start_core(ArcaneHost *host, GError **error) {
  gchar *exe_dir = executable_directory();
  gchar *packaged = g_build_filename(exe_dir, "ArcaneCore", NULL);
  GPtrArray *arguments = g_ptr_array_new_with_free_func(g_free);
  if (g_file_test(packaged, G_FILE_TEST_IS_EXECUTABLE)) {
    g_ptr_array_add(arguments, g_strdup(packaged));
  } else {
    gchar *root_parent = g_path_get_dirname(host->bundle_root);
    gchar *source = g_build_filename(root_parent, "runtime", "arcane-core.cjs", NULL);
    if (!g_file_test(source, G_FILE_TEST_IS_REGULAR)) {
      g_free(source);
      source = g_build_filename(host->bundle_root, "runtime", "arcane-core.cjs", NULL);
    }
    if (!g_file_test(source, G_FILE_TEST_IS_REGULAR)) {
      g_set_error(error, G_IO_ERROR, G_IO_ERROR_NOT_FOUND, "ArcaneCore and the development core source are both missing.");
      g_free(root_parent); g_free(source); g_free(packaged); g_free(exe_dir); g_ptr_array_unref(arguments);
      return FALSE;
    }
    g_ptr_array_add(arguments, g_strdup("node"));
    g_ptr_array_add(arguments, source);
    g_free(root_parent);
  }
  g_ptr_array_add(arguments, g_strdup_printf("--app=%s", ARCANE_APP));
  g_ptr_array_add(arguments, g_strdup_printf("--bundle-root=%s", host->bundle_root));
  for (guint index = 1; host->host_argv && host->host_argv[index]; index++)
    if (arg_allowed_for_core(host->host_argv[index])) g_ptr_array_add(arguments, g_strdup(host->host_argv[index]));
  g_ptr_array_add(arguments, NULL);

  host->core = g_subprocess_newv((const gchar * const *)arguments->pdata,
    G_SUBPROCESS_FLAGS_STDIN_PIPE | G_SUBPROCESS_FLAGS_STDOUT_PIPE | G_SUBPROCESS_FLAGS_STDERR_PIPE,
    error);
  g_ptr_array_unref(arguments);
  g_free(packaged); g_free(exe_dir);
  if (!host->core) return FALSE;
  host->core_stdin = g_subprocess_get_stdin_pipe(host->core);
  host->core_stdout = g_subprocess_get_stdout_pipe(host->core);
  host->core_stderr = g_subprocess_get_stderr_pipe(host->core);
  g_thread_unref(g_thread_new("arcane-core-reader", read_core_thread, host));
  g_thread_unref(g_thread_new("arcane-core-errors", read_core_errors_thread, host));
  return TRUE;
}

static void on_load_changed(WebKitWebView *view, WebKitLoadEvent event, gpointer user_data) {
  ArcaneHost *host = user_data;
  if (event != WEBKIT_LOAD_FINISHED) return;
  host->web_ready = TRUE;
  while (!g_queue_is_empty(host->pending_messages)) {
    gchar *json = g_queue_pop_head(host->pending_messages);
    gchar *script = g_strdup_printf("window.__arcaneReceive(%s);", json);
    webkit_web_view_evaluate_javascript(view, script, -1, NULL, "arcane-native", NULL, NULL, NULL);
    g_free(script); g_free(json);
  }
}

static gboolean uri_matches_app(const ArcaneHost *host, const gchar *uri) {
  if (!host->app_uri || !uri || !g_str_has_prefix(uri, host->app_uri)) return FALSE;
  const gchar *suffix = uri + strlen(host->app_uri);
  return *suffix == '\0' || *suffix == '?' || *suffix == '#';
}

static gboolean on_decide_policy(WebKitWebView *view,
                                 WebKitPolicyDecision *decision,
                                 WebKitPolicyDecisionType decision_type,
                                 gpointer user_data) {
  (void)view;
  ArcaneHost *host = user_data;
  if (decision_type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) {
    webkit_policy_decision_ignore(decision);
    return TRUE;
  }
  if (decision_type != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION) return FALSE;

  WebKitNavigationAction *action = webkit_navigation_policy_decision_get_navigation_action(
    WEBKIT_NAVIGATION_POLICY_DECISION(decision));
  WebKitURIRequest *request = action ? webkit_navigation_action_get_request(action) : NULL;
  const gchar *uri = request ? webkit_uri_request_get_uri(request) : NULL;
  if (uri_matches_app(host, uri)) webkit_policy_decision_use(decision);
  else webkit_policy_decision_ignore(decision);
  return TRUE;
}

static gboolean on_permission_request(WebKitWebView *view,
                                      WebKitPermissionRequest *request,
                                      gpointer user_data) {
  ArcaneHost *host = user_data;
  gboolean allow_microphone = g_strcmp0(ARCANE_APP, "shell") == 0
    && uri_matches_app(host, webkit_web_view_get_uri(view))
    && WEBKIT_IS_USER_MEDIA_PERMISSION_REQUEST(request)
    && webkit_user_media_permission_is_for_audio_device(WEBKIT_USER_MEDIA_PERMISSION_REQUEST(request))
    && !webkit_user_media_permission_is_for_video_device(WEBKIT_USER_MEDIA_PERMISSION_REQUEST(request));
  if (allow_microphone) webkit_permission_request_allow(request);
  else webkit_permission_request_deny(request);
  return TRUE;
}

static void activate(GtkApplication *application, gpointer user_data) {
  ArcaneHost *host = user_data;
  host->application = application;
  host->window = GTK_WINDOW(gtk_application_window_new(application));
  gtk_window_set_title(host->window, g_strcmp0(ARCANE_APP, "shell") == 0 ? "Arcane OS" : "Arcane OS Provisioner");
  gtk_window_set_default_size(host->window, 1240, 860);
  gtk_window_set_icon_name(host->window, "arcane-os");

  GError *error = NULL;
  host->bundle_root = locate_bundle_root();
  if (!host->bundle_root) {
    GtkWidget *dialog = gtk_message_dialog_new(host->window, GTK_DIALOG_MODAL, GTK_MESSAGE_ERROR, GTK_BUTTONS_CLOSE,
      "Arcane could not find arcane-bundle.json and the application payload.");
    gtk_window_present(GTK_WINDOW(dialog));
    return;
  }
  if (!start_core(host, &error)) {
    GtkWidget *dialog = gtk_message_dialog_new(host->window, GTK_DIALOG_MODAL, GTK_MESSAGE_ERROR, GTK_BUTTONS_CLOSE,
      "Arcane Core could not start: %s", error ? error->message : "unknown error");
    gtk_window_present(GTK_WINDOW(dialog));
    if (error) g_error_free(error);
    return;
  }

  WebKitUserContentManager *manager = webkit_user_content_manager_new();
  g_signal_connect(manager, "script-message-with-reply-received::arcane", G_CALLBACK(on_script_message), host);
  if (!webkit_user_content_manager_register_script_message_handler_with_reply(manager, "arcane", NULL)) {
    g_warning("Arcane could not register the WebKitGTK native bridge.");
  }
  host->web_view = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW, "user-content-manager", manager, NULL));
  g_object_unref(manager);
  WebKitSettings *settings = webkit_web_view_get_settings(host->web_view);
  webkit_settings_set_enable_developer_extras(settings, g_getenv("ARCANE_DEVTOOLS") != NULL);
  webkit_settings_set_enable_write_console_messages_to_stdout(settings, FALSE);
  webkit_settings_set_allow_file_access_from_file_urls(settings, FALSE);
  webkit_settings_set_allow_universal_access_from_file_urls(settings, FALSE);
  webkit_settings_set_javascript_can_open_windows_automatically(settings, FALSE);
  g_signal_connect(host->web_view, "load-changed", G_CALLBACK(on_load_changed), host);
  g_signal_connect(host->web_view, "decide-policy", G_CALLBACK(on_decide_policy), host);
  g_signal_connect(host->web_view, "permission-request", G_CALLBACK(on_permission_request), host);
  gtk_window_set_child(host->window, GTK_WIDGET(host->web_view));
  if (g_strcmp0(ARCANE_APP, "shell") == 0) gtk_window_fullscreen(host->window);

  gchar *installed_app = g_build_filename(host->bundle_root, "app", NULL);
  gchar *app_root = g_file_test(installed_app, G_FILE_TEST_IS_DIR)
    ? g_strdup(installed_app)
    : g_build_filename(host->bundle_root, "dist", "app", NULL);
  gchar *index = g_build_filename(app_root, ARCANE_APP, "index.html", NULL);
  g_free(installed_app);
  g_free(app_root);
  gchar *uri = g_filename_to_uri(index, NULL, &error);
  if (!uri) {
    g_warning("Arcane could not create the application URI: %s", error->message);
    g_error_free(error);
  } else {
    host->app_uri = uri;
    webkit_web_view_load_uri(host->web_view, host->app_uri);
  }
  g_free(index);
  gtk_window_present(host->window);
}

static void shutdown_host(GApplication *application, gpointer user_data) {
  ArcaneHost *host = user_data;
  if (host->core) g_subprocess_force_exit(host->core);
  if (host->core) g_object_unref(host->core);
  if (host->bundle_root) g_free(host->bundle_root);
  if (host->app_uri) g_free(host->app_uri);
  if (host->pending_messages) g_queue_free_full(host->pending_messages, g_free);
  g_mutex_clear(&host->write_mutex);
}

int main(int argc, char **argv) {
  ArcaneHost host = {0};
  host.host_argv = argv;
  host.pending_messages = g_queue_new();
  g_mutex_init(&host.write_mutex);
  const gchar *application_id = g_strcmp0(ARCANE_APP, "shell") == 0 ? "org.arcane.os.shell" : "org.arcane.os.provisioner";
  GtkApplication *application = gtk_application_new(application_id, G_APPLICATION_DEFAULT_FLAGS);
  g_signal_connect(application, "activate", G_CALLBACK(activate), &host);
  g_signal_connect(application, "shutdown", G_CALLBACK(shutdown_host), &host);
  int status = g_application_run(G_APPLICATION(application), argc, argv);
  g_object_unref(application);
  return status;
}
