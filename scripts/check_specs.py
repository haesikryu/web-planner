"""Check local contract references and FEAT-001 traceability; no runtime claims."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT / 'contracts/openapi.json').read_text())
errors = []


def check(condition, message):
    if not condition:
        errors.append(message)


def walk(value):
    if isinstance(value, dict):
        if '$ref' in value:
            target = value['$ref']
            check(target.startswith('#/'), 'External ref not checked: ' + target)
            if target.startswith('#/'):
                node = CONTRACT
                try:
                    for part in target[2:].split('/'):
                        node = node[part.replace('~1', '/').replace('~0', '~')]
                except (KeyError, TypeError):
                    errors.append('Unresolved ref: ' + target)
        for child in value.values():
            walk(child)
    elif isinstance(value, list):
        for child in value:
            walk(child)


walk(CONTRACT)
check(CONTRACT['openapi'] == '3.1.1', 'Unexpected contract version')
operations = []
for path, methods in CONTRACT['paths'].items():
    for method, operation in methods.items():
        operations.append(operation['operationId'])
        check(bool(operation.get('responses')), 'Missing responses: ' + path)
        if path != '/api/logout':
            check(operation.get('security', CONTRACT.get('security')) == [{'SessionCookie': []}],
                  'Missing session requirement: ' + path)
        if method in ('post', 'patch') and path != '/api/logout':
            params = {p.get('$ref', '') for p in operation.get('parameters', [])}
            check('#/components/parameters/CSRF' in params, 'Missing CSRF: ' + path)
            check('#/components/parameters/IdempotencyKey' in params, 'Missing key: ' + path)
        if method == 'patch':
            check('#/components/parameters/IfMatch' in params, 'Missing If-Match: ' + path)
            check('412' in operation['responses'] and '428' in operation['responses'],
                  'Missing version errors: ' + path)
check(len(operations) == len(set(operations)), 'Duplicate operationId')

feature = (ROOT / 'specs/001-capture-complete/acceptance.feature').read_text()
trace = (ROOT / 'specs/001-capture-complete/traceability.md').read_text()
planned = set(re.findall(r'\| (V-\d+) \|', trace))
tagged = set(re.findall(r'@(V-\d+)\b', feature))
check(planned == tagged, 'Scenario/traceability mismatch: ' + str(planned ^ tagged))
tasks = (ROOT / 'specs/001-capture-complete/tasks.md').read_text()
check(len(re.findall(r'^\| T-\d+ \|', tasks, re.M)) == 11, 'Expected 11 planned tasks')

for path in ROOT.rglob('*.md'):
    if '.git' in path.parts:
        continue
    text = path.read_text()
    check(not re.search(r'[A-Z0-9._%+-]+@(?:gmail\.com)\b', text, re.I),
          'Personal email in public document: ' + str(path.relative_to(ROOT)))
    check('docs.google.com/spreadsheets/d/' not in text,
          'Private source link in public document: ' + str(path.relative_to(ROOT)))

if errors:
    raise SystemExit('\n'.join(errors))
print(f'PASS: JSON refs, {len(operations)} API operations, '
      f'{len(planned)} verification groups, '
      f'{feature.count("  시나리오:")} scenarios, 11 planned tasks.')
print('This is a structural check, not full OpenAPI validation or product test execution.')
