#!/bin/bash
# Known-yes and known-no cases for scripts/privacy-check.mjs. Term list is synthetic.
SCRIPT="$(cd "$(dirname "$0")" && pwd)/privacy-check.mjs"
run() ( # name, expect(0|1), setup-cmd; subshell so exports do not leak
  d=$(mktemp -d); cd "$d"; git init -q; git config user.name "Neutral Person"; git config user.email "1+neutral@users.noreply.github.com"
  printf 'zebrafinch\nword:bob\n\xe6\xb5\x8b\xe8\xaf\x95\xe5\x90\x8d\n' > .privacy-denylist; echo .privacy-denylist > .gitignore
  eval "$3"
  TZ=${TZV:-UTC} node "$SCRIPT" >/dev/null 2>&1; got=$([ $? -eq 0 ] && echo 0 || echo 1)
  [ "$got" = "$2" ] && echo "ok   $1" || echo "FAIL $1 (expected $2 got $got)"
  cd /; rm -rf "$d"
)
run "clean"                     0 'echo "hello bobcat bobsled" > a.txt'
run "plain term"                1 'echo "by ZebraFinch" > a.txt'
run "chinese term (utf8)"       1 'printf "\xe4\xbd\x9c\xe8\x80\x85\xef\xbc\x9a\xe6\xb5\x8b\xe8\xaf\x95\xe5\x90\x8d\n" > a.txt'
run "spaced term"               1 'echo "zebra finch" > a.txt'
run "zero-width term"           1 'printf "zebra\xe2\x80\x8bfinch\n" > a.txt'
run "base64 term"               1 'echo "x=$(printf "hi zebrafinch!" | base64)" > a.txt'
run "base64 term, offset 1"     1 'echo "x=$(printf "a zebrafinch" | base64)" > a.txt'
run "inside long base64 blob"   1 'echo "B=\"$(head -c 300 /dev/zero | tr "\0" a; printf " Zebrafinch")\"" | python3 -c "import sys,base64;s=sys.stdin.read();print(base64.b64encode(s.encode()).decode())" > a.txt'
run "inside flate stream"       1 'python3 -c "import zlib,sys;sys.stdout.buffer.write(b\"obj stream\n\"+zlib.compress(b\"Author zebrafinch\")+b\"\nendstream\")" > a.pdf'
run "word term as word"         1 'echo "by Bob." > a.txt'
run "word term inside word"     0 'echo "bobcat bobsled" > a.txt'
run "git user.name word term"   1 'git config user.name Bob; echo hi > a.txt'
run "GIT_AUTHOR_EMAIL env"      1 'export GIT_AUTHOR_EMAIL=zebrafinch@x.com; echo hi > a.txt'
TZV=Etc/GMT+5 run "non-UTC timezone" 1 'echo hi > a.txt'
run "allowed identity passes"   0 'printf "Zebra Bot\n9+zebrafinch@users.noreply.github.com\n" > .privacy-allow-identity; echo .privacy-allow-identity >> .gitignore; git config user.name "Zebra Bot"; git config user.email 9+zebrafinch@users.noreply.github.com; echo hi > a.txt'
run "allowed identity, term in file still fails" 1 'printf "9+zebrafinch@users.noreply.github.com\n" > .privacy-allow-identity; echo .privacy-allow-identity >> .gitignore; git config user.email 9+zebrafinch@users.noreply.github.com; echo zebrafinch > a.txt'
run "other identity still fails" 1 'printf "9+zebrafinch@users.noreply.github.com\n" > .privacy-allow-identity; echo .privacy-allow-identity >> .gitignore; git config user.email zebrafinch@mail.example; echo hi > a.txt'
