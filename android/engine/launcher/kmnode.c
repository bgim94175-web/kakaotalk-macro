/*
 * Starts the embedded Node runtime (libnode.so from nodejs-mobile) as an ordinary process.
 *
 * Shipped as lib/<abi>/libkmnode.so so the package installer extracts it into the app's
 * nativeLibraryDir: since Android 10 that is the only app-owned location exec() is allowed from.
 * Running Node as a child process (instead of in-process via JNI) lets the app restart it
 * after a crash; node::Start can only run once per process.
 */
extern int node_start(int argc, char **argv) __asm__("_ZN4node5StartEiPPc");

int main(int argc, char **argv) {
    return node_start(argc, argv);
}
