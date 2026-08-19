# external-app (fixture)

A stand-in for an app whose source, build and history live in someone
else's repository. It exists so this repository can prove that an
externally built module is verified exactly like a locally built one, with
no real external repository in the loop and no network access.

The bundle that points here is `test/fixtures/external-bundle/`, and the
whole contract between them is that bundle's own `build` object: a command
run at this directory's root, and the artifact that command leaves behind.
puck's verifier copies this directory into a temporary checkout, runs the
command there, and takes `dist/app.wasm`
(`tools/externalBuild.ts`).

Nothing here includes `emu_abi.h` or any other file from puck, and the ABI
symbols are exported from the C itself with
`__attribute__((export_name(...)))` rather than through linker flags. An
external app depends on the ABI, not on this tree and not on this
repository's build conventions.

There is deliberately no build script in this directory: the bundle's
command is one compiler invocation. Two reasons. It keeps the fixture's
moving parts to the ones actually under test (copy, run, take the
artifact), and it avoids a toolchain trap measured on this machine: a
`zig cc` invoked from a bun process nested inside another bun process
(the shape `bun run verify-bundle` produces once the bundle's command is
itself `bun run something.ts`) crashes in the linker on every attempt,
silently, with the same exit code AGENTS.md documents as an occasional
flake. Invoked from the shell directly, at the same depth, it compiles
first try. A real external repository is of course free to run whatever it
wants; this is a note about why the fixture is shaped the way it is.

Not listed in `registry.json`, deliberately: a fixture is test material,
never something a gallery or a registry advertises.
