#!/usr/bin/env python3
"""Invite-name and past-rounds mutants (Mobile Core). Each edit must fail friends-invite-past.test.js.
Run from the repo root: python3 scripts/friends-invite-past-mutants.py"""
import subprocess,sys
import os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
P='friends.js'; orig=open(P).read()
M=[
('M1','  await deleteIfPresent(boards, friendKvKey("invname", previous));\n',''),
('M2','return friendJson(200, name ? { ownerId, name } : { ownerId }, cors);','return friendJson(200, { ownerId }, cors);'),
('M3','  if (body.rounds.length > limit) return friendJson(400, { error: "invalid_body" }, cors);\n',''),
('M4','  if (choice === "10") return 10;','  if (choice === "10") return 25;'),
('M5','      if (Array.isArray(round.to) && !round.to.includes(caller.ownerId)) continue;\n',''),
('M6','  return friendJson(200, { rounds: rounds.map(publicRound) }, cors);','  return friendJson(200, { rounds }, cors);'),
('M7','  const next = withoutAudience(await loadOwnedRounds(boards, caller.ownerId), ownerId);','  const next = await loadOwnedRounds(boards, caller.ownerId);'),
('M8','  await deletePastRoundsFor(boards, ownerId, caller.ownerId);\n  return friendJson(200, { ok: true }, cors);\n}\n\nasync function publishRound','  return friendJson(200, { ok: true }, cors);\n}\n\nasync function publishRound'),
('M9','  if (raw.length < 1 || [...raw].length > INVITE_NAME_MAX) return null;','  if (raw.length < 1) return null;'),
('M10','    const clean = sanitizeRound(round, caller.ownerId);\n    if (!clean || seen.has(clean.id))','    const clean = round;\n    if (!clean || seen.has(clean.id))'),
('M11','  if (!(await areFriends(boards, caller.ownerId, ownerId)) || !(await areFriends(boards, ownerId, caller.ownerId))) {\n    return friendJson(409','  if (false) {\n    return friendJson(409'),
]
bad=[]
for mid,a,b in M:
    if orig.count(a)!=1: print(mid,'NOMATCH',orig.count(a)); bad.append(mid); continue
    open(P,'w').write(orig.replace(a,b))
    r=subprocess.run('npx vitest run friends-invite-past.test.js',shell=True,capture_output=True,text=True)
    killed=r.returncode!=0
    print(mid,'killed' if killed else 'SURVIVED'); 
    if not killed: bad.append(mid)
open(P,'w').write(orig)
sys.exit(1 if bad else 0)
