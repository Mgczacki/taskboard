#!/usr/bin/env python3
"""Print a TLC counterexample from a runs/*.out file compactly: one line per step with the action name and
only the variables that changed.  usage: python3 trace.py runs/X.out"""
import re, sys

text = open(sys.argv[1]).read()
blocks = re.split(r'\nState (\d+): ', text)
prev = {}
print(re.search(r'Error: (.*)', text).group(0) if 'Error:' in text else 'no error')
for i in range(1, len(blocks), 2):
    num, body = blocks[i], blocks[i + 1]
    head, _, rest = body.partition('\n')
    rest = rest.split('\n\n')[0] + '\n'
    m = re.match(r'<(\w+)', head)
    act = m.group(1) if m else head.strip()
    cur = {}
    for vm in re.finditer(r'^/\\ (\w+) = (.*?)(?=^/\\ |\Z)', rest, re.S | re.M):
        cur[vm.group(1)] = ' '.join(vm.group(2).split())
    changed = {k: v for k, v in cur.items() if prev.get(k) != v}
    if 'Back to state' in head or 'Stuttering' in head:
        print(f'{num:>3} {head.strip()}')
    print(f'{num:>3} {act:<22} ' + '; '.join(f'{k}={v}' for k, v in changed.items()))
    prev = cur
for m in re.finditer(r'(Back to state.*|Stuttering)', text):
    print('    ' + m.group(1))
