# 0005: An external port is reproduced, not trusted

Date: 2026-08-20
Status: accepted

## The question

`bun run verify-bundle` assumed every port was one local C file compiled by
a local pack's `wasm/build.ts`. That works for the apps in this
repository's own `apps/` directory and for nothing else. An app whose
author keeps their own source, their own toolchain and their own history
elsewhere could not be listed at all, even though `registry.json` has
always accepted a `{"name","url"}` entry and
`docs/convention/app-bundle.md` has always said an app "may live in an
author's own repository".

The obvious shortcut is to let such a bundle ship a prebuilt `.wasm` and
verify that. This decision records why that was refused, and what was
built instead.

## What was refused: a submitted binary

A bundle that ships a module is asking to be believed about the one thing
this repository never takes on prose: that the module it hands over is
what its source produces. `docs/convention/app-bundle.md`'s "listing is a
reproduction, not a submission" exists because a README can claim anything
and a recorded frame cannot. A prebuilt artifact moves the same claim one
level down: the frames would still be checked, but against a binary
nobody here produced, from a source nobody here compiled. The check would
pass for a module that no longer corresponds to the source it names, which
is precisely the failure mode a verifier exists to catch.

## What was built: the same claim, one step earlier

A port may declare a `build` object: a repository, a commit sha, a command
to run at that checkout's root, and the artifact that command leaves
behind. The verifier clones (or, for a local path, copies) at that commit
into a temporary directory, runs the command there, takes the artifact,
and then verifies it **exactly like a locally built module**: the same
traces, the same recorded frames, the same tolerance, the same code path
(`harness/portdiff.ts`'s `verifyPortFrames`, `harness/invariantRun.ts`'s
`runInvariants`). Nothing in verification knows whether the module came
from a local pack or from someone else's repository, and that is the
design: an external port is not a softer claim, it is the same claim about
a module that was built somewhere else.

Four guards make "reproduction" mean something:

- **The commit must be a sha.** A branch or a tag names a moving target,
  and a build that can move is not a reproduction. The one exception,
  spelled `"working-tree"`, exists for a local directory with no git
  history (a fixture, a developer's scratch checkout) and is reported as
  unpinned everywhere provenance is shown. A local directory that HAS
  history is refused if it asks for it: a repository with a commit must
  name one.
- **The artifact is deleted before the command runs.** Otherwise a `.wasm`
  committed into the repository, or left behind in a copied working tree,
  would pass as a build output that never ran. "The artifact exists" has
  to mean "this command produced it".
- **The artifact must stay inside the checkout.** No absolute path, no
  `..` segment.
- **Provenance is reported, not implied.** A passing external port prints
  what was built and from where, so a reader of a green table never has to
  assume this repository built it.

## Trust model

**Listing a bundle that declares a build command means the operator
chooses to execute that repository's build on their own machine.** There
is no sandbox here and none is claimed. `bash -c <command>` at the root of
a checkout can do whatever the machine running it can do.

This is an owner-level decision, and it is the only one consistent with
"listing is a reproduction". A reproduction is, definitionally, running
someone else's build. The alternatives were considered and are worse:
accepting a prebuilt binary trades an executed build command for an
unverifiable artifact (see above, and note that running an untrusted
`.wasm` in a host you also wrote is not obviously safer than running an
untrusted build); an allowlist of "safe" build commands is security
theatre, since every real build shells out; a container or VM is a real
answer, and a real dependency this repository does not carry, for a tool
whose whole promise is `bun install && bun run dev`.

What the pin buys is narrower and worth stating exactly: it makes the
executed command **fixed and citable**, so what ran can be read before it
runs and named afterwards. It does not make it safe. It also does not
protect against a repository whose history is rewritten under the same
sha, which git's own object model already makes impractical, nor against
a build that reaches the network for a dependency, which the pin does not
cover at all.

Practically: read a bundle's `build.command` before listing it, the same
way you would read a `package.json` script before running `npm install`,
and prefer to verify unfamiliar bundles where a compromised machine
matters least. CI (`tools/ci-verify-registry.ts`, the zero-secret
workflow) is the right place for that, and it holds no secrets by
construction.

## How this is proven

`test/fixtures/external-app/` is a whole app in one C file, standing in
for a repository that is not puck: it includes nothing from this tree and
exports the ABI from its own source. `test/fixtures/external-bundle/` is a
bundle that points at it by local path, with a trace and three recorded
frames, and it is deliberately NOT listed in `registry.json`: a fixture is
test material, never something a gallery advertises.

Two levels of check:

- `bun run test:external` drives `tools/externalBuild.ts` directly: the
  fixture builds and instantiates, a command producing no artifact fails
  naming it, a branch name where a sha belongs is rejected, an artifact
  escaping the checkout is rejected, a repository with history refuses an
  unpinned build, and provenance reads honestly.
- `bun run verify-bundle test/fixtures/external-bundle` runs the whole
  path end to end.

Red before green, verified rather than assumed, both at the bundle level:

- Change the fixture's own C so it draws a bigger box than its recorded
  frames: `FAIL 3/3 frame(s) diverged (first: box t=0ms, 28/1024px)`.
  Restore it: `PASS: 1/1 port(s) verified`.
- Point `artifact` at a file the command does not produce:
  `ERROR build command succeeded but produced no dist/other.wasm`.
  Restore it: `PASS: 1/1 port(s) verified`.
- Remove the commit-sha rule from validation and `bun run test:external`
  fails on its own check 3, rather than passing regardless.

## A toolchain note, since the fixture's shape encodes it

The fixture's build command is a single compiler invocation rather than
`bun run build.ts`. Measured on the development machine (Windows on ARM):
a `zig cc` invoked from a bun process nested inside another bun process,
which is exactly the shape `bun run verify-bundle` produces once the
bundle's own command is `bun run something.ts`, crashes in the linker on
every attempt, silently, with the same exit code AGENTS.md documents as an
occasional flake. From the shell directly, at the same depth, it compiles
first try. Nothing in this repository's code causes it and nothing here
works around it; the fixture simply does not stand in that spot. A real
external repository runs whatever command it runs, and if that command
hits this, the failure is reported as a build failure with the command
and its output, which is the honest outcome.
