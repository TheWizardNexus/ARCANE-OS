#define main arcane_host_packaged_main
#include "../src/hosts/linux/arcane_host.c"
#undef main

typedef struct {
  ArcaneHost host;
  gint status;
} ArcaneHostProbe;

static void probe_activate(GApplication *application, gpointer user_data) {
  ArcaneHostProbe *probe = user_data;
  GError *error = NULL;
  probe->host.bundle_root = locate_bundle_root();
  if (!probe->host.bundle_root) {
    g_printerr("Arcane host probe could not locate its packaged release root.\n");
    probe->status = 2;
    g_application_quit(application);
    return;
  }
  if (!start_core(&probe->host, &error)) {
    g_printerr("Arcane host probe could not start its Core: %s\n", error ? error->message : "unknown error");
    if (error) g_error_free(error);
    probe->status = 3;
    g_application_quit(application);
    return;
  }
  if (!g_subprocess_wait_check(probe->host.core, NULL, &error)) {
    g_printerr("Arcane host probe Core failed: %s\n", error ? error->message : "unknown error");
    if (error) g_error_free(error);
    probe->status = 4;
  }
  g_usleep(100000);
  g_application_quit(application);
}

int main(int argc, char **argv) {
  ArcaneHostProbe probe = {0};
  capture_exact_main_option_tokens(&probe.host, argc, argv);
  probe.host.pending_messages = g_queue_new();
  g_mutex_init(&probe.host.write_mutex);
  GApplication *application = g_application_new(
    "org.arcane.os.ReleaseClaimProbe",
    G_APPLICATION_NON_UNIQUE
  );
  register_main_options(application, &probe.host);
  g_signal_connect(application, "activate", G_CALLBACK(probe_activate), &probe);
  gint run_status = g_application_run(application, argc, argv);
  g_object_unref(application);
  return run_status == 0 ? probe.status : run_status;
}
