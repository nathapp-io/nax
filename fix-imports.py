import os, glob, re

repo = '/Users/subrinaai/Desktop/workspace/subrina-coder/projects/nax/repos/nax'
fixed = []

for fpath in glob.glob(repo + '/test/**/*.test.ts', recursive=True):
    relpath = os.path.relpath(fpath, repo)
    depth = len(relpath.split('/')) - 1

    with open(fpath) as f:
        content = f.read()

    # Match relative imports like ../../src/ or ../src/
    pattern = r'(["\'])((\.\.\/){1,5})src\/'
    matches = re.findall(pattern, content)
    prefixes = set(m[1] for m in matches)
    if not prefixes:
        continue

    expected = '../' * depth
    new_content = content
    changed = False
    for prefix in prefixes:
        if prefix != expected:
            new_content = new_content.replace(prefix + 'src/', expected + 'src/')
            changed = True

    if changed:
        with open(fpath, 'w') as f:
            f.write(new_content)
        fixed.append(f'{relpath}: {repr(list(prefixes)[0])} -> {repr(expected)}')

print(f'Fixed {len(fixed)} files:')
for f in fixed:
    print(' ', f)
