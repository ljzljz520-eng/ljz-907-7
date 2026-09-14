#!/usr/bin/env bash
# 端到端冒烟测试：在临时数据库上启动服务，跑通全链路后清理
set -u
cd "$(dirname "$0")/.."
PORT=3917
TMPD=$(mktemp -d)
BASE="http://localhost:$PORT"
PASS=0; FAIL=0
ok()   { if [ "$1" = "$2" ]; then PASS=$((PASS+1)); echo "  ✓ $3"; else FAIL=$((FAIL+1)); echo "  ✗ $3 (期望 $2 实际 $1)"; fi; }
jget() { node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  try {
    const j=JSON.parse(d);
    const expr=process.argv[1].replace(/^\./,"");
    const f=new Function("o","return o."+expr);
    const v=f(j);
    console.log(v===undefined||v===null?"":v);
  } catch(e){ console.log("PARSE_ERR:"+e.message); }
});' "$1"; }

PORT=$PORT VLIB_DATA_DIR="$TMPD" node src/server.js > "$TMPD/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$TMPD"' EXIT
sleep 2

echo "[1] 鉴权"
ok "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/my/videos)" "401" "未登录访问被拒绝"
ADMIN=$(curl -s -c $TMPD/a.jar -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' $BASE/api/auth/login)
ok "$(echo "$ADMIN" | jget ".user.role")" "admin" "管理员登录"
ok "$(curl -s -o /dev/null -w '%{http_code}' -b $TMPD/a.jar $BASE/)" "200" "首页可访问"

echo "[2] 岗位必看片匹配"
curl -s -c $TMPD/z.jar -H 'Content-Type: application/json' -d '{"username":"zhangwei","password":"vol123"}' $BASE/api/auth/login >/dev/null
ok "$(curl -s -b $TMPD/z.jar $BASE/api/my/videos | jget ".total")" "4" "导览岗看到 2 通用+2 导览=4 部"
ok "$(curl -s -o /dev/null -w '%{http_code}' -b $TMPD/z.jar $BASE/api/my/videos/6)" "404" "导览岗看不到急救片"

echo "[3] CSV 导入"
printf '用户名,密码,姓名,岗位,角色\nzhao,vol123,赵六,导览服务,volunteer\n,,缺名,导览,volunteer\n' > $TMPD/u.csv
R=$(curl -s -b $TMPD/a.jar -F "file=@$TMPD/u.csv" $BASE/api/admin/import/users)
ok "$(echo "$R" | jget ".inserted")" "1" "导入1名新用户"
ok "$(echo "$R" | jget ".errors.length")" "1" "错误行被精确报告"
printf '编号,片名,适用岗位,视频地址,时长分钟,考试提示,简介\nV100,"测试片,逗号",通用,,8,"考点A""引号",简介\n' > $TMPD/v.csv
R=$(curl -s -b $TMPD/a.jar -F "file=@$TMPD/v.csv" $BASE/api/admin/import/videos)
ok "$(echo "$R" | jget ".inserted")" "1" "影片导入（引号/逗号转义）"
ok "$(curl -s -b $TMPD/a.jar "$BASE/api/admin/videos" | jget ".videos.find(v=>v.code==='V100').exam_tips")" '考点A"引号' "考试提示正确落库"

echo "[4] 反馈与统计"
VID=$(curl -s -b $TMPD/z.jar $BASE/api/my/videos | jget ".videos[0].id")
ok "$(curl -s -b $TMPD/z.jar -H 'Content-Type: application/json' -d '{"watched":1,"rating":5,"comment":"好"}' $BASE/api/my/videos/$VID/feedback | jget ".watched")" "1" "提交观看反馈"
ok "$(curl -s -b $TMPD/z.jar -H 'Content-Type: application/json' -d '{"watched":0}' $BASE/api/my/videos/$VID/feedback | jget ".watched")" "1" "完成状态不可逆"
S=$(curl -s -b $TMPD/a.jar --data-urlencode "position=导览服务" -G $BASE/api/admin/stats)
ok "$(echo "$S" | jget ".overview.volunteers")" "2" "导览岗共2名志愿者（张伟+赵六）"
ok "$(echo "$S" | jget ".videos.find(v=>v.id===$VID).completed_count")" "1" "影片完成人数统计为1"

echo "[5] 越权"
ok "$(curl -s -o /dev/null -w '%{http_code}' -b $TMPD/z.jar $BASE/api/admin/users)" "403" "志愿者无法访问管理接口"

echo; echo "结果: $PASS 通过, $FAIL 失败"
[ $FAIL -eq 0 ]
