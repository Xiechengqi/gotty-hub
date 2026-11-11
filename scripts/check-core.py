#!/usr/bin/env python3
"""Verify vendor package sources against an optional GoTTY checkout."""
import hashlib, json, pathlib, sys, tarfile
root = pathlib.Path(__file__).resolve().parents[1]
source = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
package=json.loads((root/'frontend/package.json').read_text())['dependencies']['@gotty/terminal-core'].removeprefix('file:')
with tarfile.open(root/'frontend'/package) as archive:
    for member in archive.getmembers():
        if not member.isfile(): continue
        name=member.name.removeprefix('package/')
        payload=archive.extractfile(member).read()
        if source:
            assert payload == (source/'js/packages/terminal-core'/name).read_bytes(), name+' differs'
    manifest=json.load(archive.extractfile('package/font-manifest.json'))
    for font in manifest:
        assert archive.getmember('package/font-licenses/'+font['id']+'.txt')
        for asset in font['files']:
            data=archive.extractfile('package/fonts/'+asset['file']).read()
            assert len(data)==asset['bytes'] and hashlib.sha256(data).hexdigest()==asset['sha256']
print('PASS versioned terminal-core package' + (' matches GoTTY sources' if source else ' is readable'))
