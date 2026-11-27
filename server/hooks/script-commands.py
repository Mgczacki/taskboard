"""Read Python syntax without executing the submitted script."""
import ast
import json
import sys

tree = ast.parse(sys.stdin.read())
modules = {}
functions = {}
commands = []
paths = []
writes = []
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for item in node.names:
            modules[item.asname or item.name] = item.name
    if isinstance(node, ast.ImportFrom):
        for item in node.names:
            functions[item.asname or item.name] = (node.module, item.name)
for node in ast.walk(tree):
    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in ('eval', 'exec', 'compile', '__import__'):
        raise ValueError('Dynamic code needs a separate review.')
    if not isinstance(node, ast.Call):
        continue
    if node.args and (isinstance(node.func, ast.Name) and node.func.id in ('open', 'Path') or isinstance(node.func, ast.Attribute) and node.func.attr in ('open', 'Path', 'remove', 'unlink', 'mkdir', 'rmdir')):
        if isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            paths.append(node.args[0].value)
            if isinstance(node.func, ast.Name) and node.func.id == 'open' and len(node.args) > 1 and isinstance(node.args[1], ast.Constant) and any(mode in str(node.args[1].value) for mode in ('w', 'a', 'x', '+')):
                writes.append(node.args[0].value)
    if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
        module = modules.get(node.func.value.id)
        name = node.func.attr
    elif isinstance(node.func, ast.Name):
        module, name = functions.get(node.func.id, (None, None))
    else:
        continue
    if module == 'os' and name == 'kill':
        try:
            pid = str(ast.literal_eval(node.args[0]))
        except Exception:
            pid = '<dynamic>'
        commands.append(['kill', pid])
    if module == 'subprocess' and name in ('run', 'call', 'Popen', 'check_call', 'check_output', 'getoutput', 'getstatusoutput') or module == 'os' and name in ('system', 'popen', 'execv', 'execvp', 'execve', 'execl'):
        try:
            value = ast.literal_eval(node.args[0])
        except Exception:
            raise ValueError('The process command is dynamic. Use a separately reviewed command.')
        if not isinstance(value, (str, list, tuple)):
            raise ValueError('The process command is unknown.')
        commands.append(value)
print(json.dumps({'commands': commands, 'paths': paths, 'writes': writes}))
