#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  const char *output_path = getenv("ARCANE_HOST_PROBE_OUTPUT");
  if (!output_path || !*output_path) {
    fprintf(stderr, "ARCANE_HOST_PROBE_OUTPUT is required.\n");
    return 2;
  }
  FILE *output = fopen(output_path, "w");
  if (!output) {
    perror("Arcane host probe could not open its output");
    return 3;
  }
  for (int index = 1; index < argc; ++index) fprintf(output, "arg\t%s\n", argv[index]);
  const char *claim_names[] = {
    "ARCANE_RELEASE_SECURITY_MODE",
    "ARCANE_RELEASE_CONTENT_BINDING",
    "ARCANE_RELEASE_SIGNER_THUMBPRINT",
    "ARCANE_RELEASE_VERIFIED_AT",
    "ARCANE_RELEASE_REVOCATION_STATUS",
    "ARCANE_RELEASE_TRUST_SOURCE",
    "ARCANE_RELEASE_TIMESTAMP_VERIFIED",
    NULL
  };
  for (int index = 0; claim_names[index]; ++index) {
    const char *value = getenv(claim_names[index]);
    fprintf(output, "env\t%s\t%s\n", claim_names[index], value ? value : "<unset>");
  }
  if (fclose(output) != 0) {
    perror("Arcane host probe could not close its output");
    return 4;
  }
  return 0;
}
