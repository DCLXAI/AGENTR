function selectedEnvironment(keys: string[]): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) output[key] = value;
  }
  return output;
}

export function safeEnvironment(home: string): NodeJS.ProcessEnv {
  const output = selectedEnvironment(["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "CI"]);
  output.HOME = home;
  output.NO_COLOR = "1";
  output.CI = output.CI ?? "1";
  return output;
}

export function dockerClientEnvironment(): NodeJS.ProcessEnv {
  const output = selectedEnvironment([
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "CI",
    "HOME",
    "XDG_RUNTIME_DIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "SSH_AUTH_SOCK",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ]);
  output.NO_COLOR = "1";
  output.CI = output.CI ?? "1";
  return output;
}
