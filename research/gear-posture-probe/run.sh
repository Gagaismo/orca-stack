#!/bin/sh
# usage: run.sh <label> <new|resume:ID|continue> <prompt>
SP="C:/Users/lautaro/AppData/Local/Temp/claude/C--Users-lautaro-Documents-orca-stack/5b9fc20e-4724-40be-bd9b-a7d530cb9d62/scratchpad"
D="$SP/gear-probe-data"
cd "$D" || exit 1
LABEL="$1"; HOW="$2"; PROMPT="$3"
case "$HOW" in
  new) FLAGS="" ;;
  continue) FLAGS="--continue" ;;
  resume:*) FLAGS="--resume ${HOW#resume:}" ;;
esac
echo "{\"t\":$(date +%s)000,\"ev\":\"run\",\"label\":\"$LABEL\",\"how\":\"$HOW\",\"mode\":\"$(cat mode.txt 2>/dev/null)\",\"gear\":\"$(cat gear.txt 2>/dev/null)\"}" >> log.jsonl
MSYS_NO_PATHCONV=1 claude -p --plugin-dir "$SP/gear-probe" $FLAGS --output-format json "$PROMPT" > "out-$LABEL.json" 2> "err-$LABEL.txt"
echo "exit=$?"
node -e "const o=JSON.parse(require('fs').readFileSync('out-$LABEL.json','utf8'));console.log(JSON.stringify({sid:o.session_id,result:String(o.result).slice(0,300),usage:o.usage&&{in:o.usage.input_tokens,cr:o.usage.cache_read_input_tokens,cc:o.usage.cache_creation_input_tokens,out:o.usage.output_tokens}}))" 2>/dev/null || tail -c 600 "out-$LABEL.json"
