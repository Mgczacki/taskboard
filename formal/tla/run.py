#!/usr/bin/env python3
"""Run TLC once per property of a .cfg file, so every property gets its own result and trace.

usage: python3 run.py <Module>_<variant>.cfg [...]
Writes runs/<cfg stem>__<property>.cfg and .out, and appends one line per run to runs/results.tsv:
cfg, property, result (pass / VIOLATED / error), distinct states, seconds.
The module is the part of the cfg name before the first underscore.
"""
import os, re, subprocess, sys, time

JAR = os.path.expanduser('~/.local/share/tla/tla2tools.jar')
HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, 'runs')
os.makedirs(RUNS, exist_ok=True)


def split_cfg(text):
    base, invs, props = [], [], []
    mode = None
    for line in text.splitlines():
        s = line.strip()
        m = re.match(r'^(INVARIANTS?|PROPERTY|PROPERTIES)\b(.*)$', s)
        if m:
            mode = 'inv' if m.group(1).startswith('INV') else 'prop'
            (invs if mode == 'inv' else props).extend(m.group(2).split())
            continue
        if mode and s and re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', s):
            (invs if mode == 'inv' else props).append(s)
            continue
        mode = None
        base.append(line)
    return '\n'.join(base), invs, props


def run(cfg_path):
    stem = os.path.splitext(os.path.basename(cfg_path))[0]
    module = stem.split('_')[0]
    base, invs, props = split_cfg(open(cfg_path).read())
    jobs = [('INVARIANT', i) for i in invs if i != 'TypeOK'] + [('PROPERTY', p) for p in props]
    for kind, name in jobs:
        extra = 'INVARIANT TypeOK\n' if 'TypeOK' in invs and kind == 'INVARIANT' else ''
        cfg = os.path.join(RUNS, f'{stem}__{name}.cfg')
        open(cfg, 'w').write(f'{base}\n{extra}{kind} {name}\n')
        out = os.path.join(RUNS, f'{stem}__{name}.out')
        t0 = time.time()
        p = subprocess.run(['java', '-XX:+UseParallelGC', '-cp', JAR, 'tlc2.TLC', '-workers', 'auto', '-deadlock',
                            '-cleanup', '-metadir', os.path.join(RUNS, 'states', f'{stem}__{name}'),
                            '-config', cfg, os.path.join(HERE, module + '.tla')],
                           cwd=HERE, capture_output=True, text=True, timeout=900)
        dt = time.time() - t0
        text = p.stdout + p.stderr
        open(out, 'w').write(text)
        if re.search(r'is violated|Temporal properties were violated|Error: Deadlock', text):
            res = 'VIOLATED'
        elif 'Model checking completed. No error has been found.' in text:
            res = 'pass'
        else:
            res = 'error'
        m = re.findall(r'(\d+) distinct states found', text)
        states = m[-1] if m else '?'
        line = f'{stem}\t{name}\t{res}\t{states}\t{dt:.1f}'
        print(line, flush=True)
        with open(os.path.join(RUNS, 'results.tsv'), 'a') as f:
            f.write(line + '\n')


if __name__ == '__main__':
    for c in sys.argv[1:]:
        run(c)
