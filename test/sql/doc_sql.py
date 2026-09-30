#!/usr/bin/env python3
"""docs/keiei-owner-recovery.md の ```sql ブロックを取り出し、<...> を試験用の値に置き換えて標準出力へ。

緊急復旧（break-glass）の手順は、実際に困ったときにしか流さない。書いたまま動くことを、
普段から PostgreSQL 上で確かめておくために、文書のSQLそのものを流す（test/sql/owner_recovery.sql）。
"""
import re, sys

TENANT = "99999999-9999-9999-9999-999999999999"
OWNER = "a9000001-0000-0000-0000-000000000000"
REPL = {
    "<経営者のメール>": "owner@x", "<employee_id>": OWNER, "<user_id>": OWNER, "<tenant_id>": TENANT,
    "<経営者になる人のメール>": "owner@x", "<名前>": "依頼者", "<理由>": "理由", "<実行者>": "実行者", "<確認者>": "確認者",
}

src = open(sys.argv[1], encoding="utf-8").read()
blocks = re.findall(r"```sql\n(.*?)```", src, re.S)
if len(blocks) < 3:
    sys.exit("SQL ブロックが3つ（2-A・2-C・4）見つかりません")
for name, b in zip(["A", "C", "V"], blocks[:3]):
    for k, v in REPL.items():
        b = b.replace(k, v)
    left = re.findall(r"<[^<>\n]{1,20}>", b)
    if left:
        sys.exit(f"置き換えていない <...> が残っています: {left}")
    print(f"\\echo == block {name}\n{b}")
