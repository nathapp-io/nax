export const BUN_CHECK_SAMPLE = String.raw`=== bun check -p tsconfig.test.json (exit 1) ===
<error file="test/unit/forge-tools/log-tool.test.ts" line="90" column="86" code="TS2769">
No overload matches this call.
  ...
<source>
90 |     expect(result.content.split("\n").filter(...)).toEqual(expected);
</source>
<related file=".../bun-types/test.d.ts" line="1030" column="5">The last overload is declared here.</related>
</error>

Found 1 error in 1 file, checked 3,668 files [602.81ms]`;
