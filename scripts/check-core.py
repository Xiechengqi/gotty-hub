#!/usr/bin/env python3
"""Verify vendor package sources against an optional GoTTY checkout."""
import pathlib, sys, tarfile
root = pathlib.Path(__file__).resolve().parents[1]
source = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
with tarfile.open(root / 'frontend/vendor/gotty-terminal-core-0.2.2.tgz') as archive:
    for name in ('webtty.ts', 'voice-input.ts', 'appearance.ts', 'key-encoder.ts', 'keyboard-viewport.ts', 'mobile-key-layout.ts', 'LICENSE', 'package.json'):
        payload = archive.extractfile('package/' + name).read()
        if source:
            assert payload == (source / 'js/packages/terminal-core' / name).read_bytes(), name + ' differs'
print('PASS versioned terminal-core package' + (' matches GoTTY sources' if source else ' is readable'))
