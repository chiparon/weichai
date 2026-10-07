package com.example.assetupgrade;

import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.Map;

/**
 * Build and startup entry point for the Asset Upgrade Gateway.
 *
 * <p>This module owns the process entry only: it validates the command-line
 * request, resolves the runtime profile and the optional configuration location,
 * and reports the resolved runtime identity before handing control to the
 * application composition root. It depends on the JDK and the process
 * environment alone, so it can boot as a standalone seam regardless of which
 * provider adapters are wired in behind the module's ports.</p>
 */
public final class AssetUpgradeGateway {

    /** Stable application name used in diagnostics and startup output. */
    public static final String APPLICATION_NAME = "asset-upgrade-gateway";

    /** Build version, kept in sync with the Maven project version. */
    public static final String APPLICATION_VERSION = "0.1.0-SNAPSHOT";

    /** Exit code signalling a successful bootstrap. */
    public static final int EXIT_SUCCESS = 0;

    /** Exit code signalling a failed bootstrap after arguments were accepted. */
    public static final int EXIT_FAILURE = 1;

    /** Exit code signalling invalid command-line usage. */
    public static final int EXIT_USAGE = 2;

    /** Runtime profile used when neither an argument nor the environment selects one. */
    public static final String DEFAULT_PROFILE = "default";

    /** Environment variable consulted for the default runtime profile. */
    public static final String PROFILE_ENV_VAR = "ASSET_UPGRADE_PROFILE";

    private static final String PROFILE_PATTERN = "[A-Za-z0-9][A-Za-z0-9._-]*";

    private static final String USAGE = """
            Usage: asset-upgrade-gateway [options]

            Options:
              -h, --help               Show this help message and exit.
              -V, --version            Print version and runtime details, then exit.
              -p, --profile <name>     Select the runtime profile (default: "default").
              -c, --config <path>      Load configuration from the given file.
                  --dry-run            Validate the startup request without starting.
            """;

    private AssetUpgradeGateway() {
        // Entry-point holder: never instantiated.
    }

    /**
     * Process entry point.
     *
     * <p>Arguments are validated before any runtime is started; a non-zero
     * result terminates the JVM with that exit code so the bootstrap outcome is
     * observable by a supervising process.</p>
     *
     * @param args command-line arguments; the JVM never passes {@code null}
     */
    public static void main(String[] args) {
        String[] effectiveArgs = (args == null) ? new String[0] : args.clone();
        int status = bootstrap(effectiveArgs, System.getenv(), System.out, System.err);
        if (status != EXIT_SUCCESS) {
            System.exit(status);
        }
    }

    /**
     * Runs the bootstrap sequence against the supplied environment and streams.
     *
     * @param args        raw command-line arguments
     * @param environment the process environment used for defaults
     * @param out         stream for informational output
     * @param err         stream for diagnostics
     * @return one of {@link #EXIT_SUCCESS}, {@link #EXIT_FAILURE}, or {@link #EXIT_USAGE}
     */
    private static int bootstrap(String[] args, Map<String, String> environment,
            PrintStream out, PrintStream err) {
        String profile = defaultProfile(environment);
        Path configPath = null;
        boolean dryRun = false;

        for (int index = 0; index < args.length; index++) {
            String arg = args[index];
            if (arg == null || arg.isBlank()) {
                return usageError(err, "blank argument is not allowed");
            }

            String option = arg;
            String inlineValue = null;
            int separator = arg.indexOf('=');
            if (separator > 0) {
                option = arg.substring(0, separator);
                inlineValue = arg.substring(separator + 1);
            }

            switch (option) {
                case "-h", "--help" -> {
                    out.print(USAGE);
                    return EXIT_SUCCESS;
                }
                case "-V", "--version" -> {
                    printVersion(out);
                    return EXIT_SUCCESS;
                }
                case "--dry-run" -> {
                    if (inlineValue != null) {
                        return usageError(err, "option '" + option + "' does not take a value");
                    }
                    dryRun = true;
                }
                case "-p", "--profile" -> {
                    String value = resolveValue(args, index, inlineValue);
                    if (value == null) {
                        return usageError(err, "option '" + option + "' requires a value");
                    }
                    if (inlineValue == null) {
                        index++;
                    }
                    if (!value.matches(PROFILE_PATTERN)) {
                        return usageError(err, "invalid profile name: " + value);
                    }
                    profile = value;
                }
                case "-c", "--config" -> {
                    String value = resolveValue(args, index, inlineValue);
                    if (value == null) {
                        return usageError(err, "option '" + option + "' requires a value");
                    }
                    if (inlineValue == null) {
                        index++;
                    }
                    Path candidate;
                    try {
                        candidate = Path.of(value);
                    } catch (InvalidPathException ex) {
                        return usageError(err, "invalid configuration path: " + value);
                    }
                    if (!Files.exists(candidate)) {
                        err.println("error: configuration file not found: " + candidate);
                        return EXIT_FAILURE;
                    }
                    if (!Files.isRegularFile(candidate) || !Files.isReadable(candidate)) {
                        err.println("error: configuration file is not a readable regular file: " + candidate);
                        return EXIT_FAILURE;
                    }
                    configPath = candidate;
                }
                default -> {
                    if (option.startsWith("-")) {
                        return usageError(err, "unknown option: " + option);
                    }
                    return usageError(err, "unexpected argument: " + arg);
                }
            }
        }

        printStartup(out, profile, configPath, dryRun);
        return EXIT_SUCCESS;
    }

    private static String defaultProfile(Map<String, String> environment) {
        if (environment == null) {
            return DEFAULT_PROFILE;
        }
        String configured = environment.get(PROFILE_ENV_VAR);
        if (configured == null || configured.isBlank() || !configured.matches(PROFILE_PATTERN)) {
            return DEFAULT_PROFILE;
        }
        return configured;
    }

    private static String resolveValue(String[] args, int index, String inlineValue) {
        if (inlineValue != null) {
            return inlineValue.isBlank() ? null : inlineValue;
        }
        int next = index + 1;
        if (next >= args.length) {
            return null;
        }
        String value = args[next];
        if (value == null || value.isBlank()) {
            return null;
        }
        return value;
    }

    private static int usageError(PrintStream err, String message) {
        err.println("error: " + message);
        err.println("Run '" + APPLICATION_NAME + " --help' for usage.");
        return EXIT_USAGE;
    }

    private static void printVersion(PrintStream out) {
        out.println(APPLICATION_NAME + " " + APPLICATION_VERSION);
        out.println("java.version=" + System.getProperty("java.version", "unknown"));
        out.println("java.vendor=" + System.getProperty("java.vendor", "unknown"));
        out.println("os.name=" + System.getProperty("os.name", "unknown"));
        out.println("os.arch=" + System.getProperty("os.arch", "unknown"));
    }

    private static void printStartup(PrintStream out, String profile, Path configPath, boolean dryRun) {
        out.println(APPLICATION_NAME + " " + APPLICATION_VERSION + " starting");
        out.println("profile=" + profile);
        out.println("config=" + (configPath == null ? "(none)" : configPath.toString()));
        if (dryRun) {
            out.println("dry-run=true; validated startup request without starting the runtime");
        } else {
            out.println("ready");
        }
    }
}
