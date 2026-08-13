# 0001: The example firmware is minimal, not a shim over a real project's runtime

Date: 2026-08-13
Status: accepted

## The choice

`example/firmware/main.c` is one self-contained file with no dependency on
anything outside `wasm/emu_abi.h`: no malloc, no libc math, no printf, a
plain static array for its framebuffer. It implements nine of the ABI's
functions and deliberately skips two optional groups (apps, sound).

This repo was extracted from a project whose own emulator glue
(`emu_shim.c` in that project) was the opposite shape: it wrapped that
project's entire existing runtime (an arena allocator, a bump allocator for
a 330KB framebuffer, a hand-written `printf` subset, a full sensor
abstraction layer with a lock-free ring buffer). That glue is real,
battle-tested code, and it was a reasonable extraction candidate.

It was not used as the example here.

## Why not

The person this repo is for is arriving cold, with their own firmware
idea, trying to answer one question in under five minutes: "what do I
actually have to write to show up in this tool". A shim wrapping a
stranger's runtime answers a different question - "how did one specific
project wire its specific runtime to this ABI" - and forces a reader to
first understand that project's arena/app-table/sensor-ring architecture
before they can tell which parts are the ABI's requirement and which parts
are that project's own design choice.

`wasm/emu_abi.h` itself makes a point of being deliberately
device-agnostic; the example implementing it should demonstrate that
agnosticism, not bury it under one project's own opinions about memory
management.

## What this costs

The example does not demonstrate `malloc`, a real `printf`, or the
optional apps/sound groups. `docs/abi.md`'s "No malloc, no libc" section
and its "Optional: apps"/"Optional: sound" sections say in prose what the
example doesn't show in code, specifically so a firmware that DOES need
any of those isn't left guessing. If a second example firmware is ever
added to this repo, it should be the one to demonstrate those (a genuinely
larger, multi-app firmware), rather than working them into this one and
losing the property that made it worth keeping in the first place: someone
can read all of it in a few minutes.
