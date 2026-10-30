#!/usr/bin/env python3
"""Compile a gettext .po file to a .mo file using only the standard library.

msgfmt is not installed here, and installing it just for this is not worth it:
the MO container is a small, stable binary format (GNU gettext manual, 10.2).
"""

import ast
import struct
import sys


def parse_po(text):
    entries = []
    msgid = msgstr = None
    mode = None

    def flush():
        nonlocal msgid, msgstr
        if msgid is not None and msgstr is not None:
            entries.append((msgid, msgstr))
        msgid = msgstr = None

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('msgid '):
            if msgid is not None and msgstr is not None:
                flush()
            msgid = ast.literal_eval(line[len('msgid '):])
            mode = 'id'
        elif line.startswith('msgstr '):
            msgstr = ast.literal_eval(line[len('msgstr '):])
            mode = 'str'
        elif line.startswith('"'):
            chunk = ast.literal_eval(line)
            if mode == 'id':
                msgid += chunk
            elif mode == 'str':
                msgstr += chunk
    flush()
    return entries


def build_mo(entries):
    # gettext looks messages up with a binary search and requires msgids to be
    # strictly increasing. A duplicated msgid breaks that invariant: the lookup
    # lands on the wrong slot and can even return the file header (which carries
    # "Language: ..." and "MIME-Version: ..."), so any duplicate is an error
    # rather than something to silently drop.
    seen = set()
    dupes = []
    for msgid, _ in entries:
        if msgid in seen:
            dupes.append(msgid)
        seen.add(msgid)
    if dupes:
        raise SystemExit('duplicate msgid(s) in .po: ' +
                         ', '.join(repr(d) for d in dupes))

    entries = sorted(entries, key=lambda e: e[0])
    count = len(entries)
    # Header is 28 bytes; then key/value offset+length tables.
    key_start = 28 + count * 8 * 2
    # The string pool is key blob followed by value blob, so a value offset
    # depends on the *final* length of the key blob. Build both blobs first and
    # only then compute the two offset tables.
    ids = b''
    strs = b''
    for msgid, msgstr in entries:
        ids += msgid.encode('utf-8') + b'\x00'
        strs += msgstr.encode('utf-8') + b'\x00'

    key_table = b''
    str_table = b''
    id_off = 0
    str_off = 0
    for msgid, msgstr in entries:
        mid = msgid.encode('utf-8')
        mstr = msgstr.encode('utf-8')
        key_table += struct.pack('<II', len(mid), key_start + id_off)
        str_table += struct.pack('<II', len(mstr), key_start + len(ids) + str_off)
        id_off += len(mid) + 1
        str_off += len(mstr) + 1

    header = struct.pack(
        '<7I', 0x950412de, 0, count, 28, 28 + count * 8, 0, 0)
    return header + key_table + str_table + ids + strs


def verify_mo(path, entries):
    """Re-read the written .mo and check the invariants gettext relies on."""
    with open(path, 'rb') as fh:
        blob = fh.read()
    magic, _rev, count, key_off, val_off, _hs, _ho = struct.unpack(
        '<7I', blob[:28])
    if magic != 0x950412DE:
        raise SystemExit(f'{path}: bad magic {magic:#x}')
    if count != len(entries):
        raise SystemExit(f'{path}: {count} entries, expected {len(entries)}')
    keys = []
    for i in range(count):
        klen, koff = struct.unpack('<II', blob[key_off + i * 8:key_off + i * 8 + 8])
        keys.append(blob[koff:koff + klen])
    for i in range(1, len(keys)):
        if not keys[i - 1] < keys[i]:
            raise SystemExit(
                f'{path}: msgids not strictly increasing at {i}: '
                f'{keys[i - 1]!r} then {keys[i]!r}')
    print(f'verified: {count} entries, msgids strictly increasing')


def main():
    if len(sys.argv) != 3:
        print('usage: po2mo.py <in.po> <out.mo>', file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding='utf-8') as fh:
        entries = parse_po(fh.read())
    if not entries or entries[0][0] != '':
        entries.insert(0, ('', 'Project-Id-Version: opengnomebox\n'
                              'Content-Type: text/plain; charset=UTF-8\n'
                              'Content-Transfer-Encoding: 8bit\n'))
    with open(sys.argv[2], 'wb') as fh:
        fh.write(build_mo(entries))
    verify_mo(sys.argv[2], entries)
    print(f'{len(entries)} entries -> {sys.argv[2]}')
    return 0

if __name__ == '__main__':
    sys.exit(main())
