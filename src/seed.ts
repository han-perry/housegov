/** Demo data so every screen has something on it. Runs only on an empty database. */
import * as db from "./db";
import * as govdocs from "./services/govdocs";

const CONSTITUTION = `# Constitution of the House

*Placeholder text for the prototype. Replace with the real constitution.*

## Article I: Name and Purpose

1. This organization shall be known as the House Government.
2. Its purpose is to represent residents and manage House resources.

## Article II: Membership

1. All residents are members of the House.
2. Each member has one vote in Full Forum.

## Article III: Officers

1. The officers are the President, House Chair, Secretary and Treasurer.
2. Officers are elected each spring by ranked-choice vote.

## Article IV: Amendments

1. Amendments require a two-thirds vote of the House Committee,
   or a two-thirds vote in Full Forum.
`;

const RESERVATIONS = `# Room Reservation Policy

1. Lounges may be reserved up to two weeks in advance.
2. Reservations are limited to four hours.
3. Leave the space as clean as you found it.
`;

export async function seedIfEmpty(): Promise<void> {
  if (await db.get("SELECT 1 FROM docs LIMIT 1")) return;
  console.log("[seed] empty database, adding demo data");

  await govdocs.createDoc({ slug: "constitution", title: "Constitution", category: "Constitution", content: CONSTITUTION, author: "perryh" });
  await govdocs.createDoc({ slug: "reservations", title: "Room Reservation Policy", category: "Policy", content: RESERVATIONS, author: "perryh" });

  const day = 24 * 3600 * 1000;
  const now = Date.now();
  const nextMeeting = new Date(now + 5 * day);
  nextMeeting.setHours(21, 0, 0, 0);
  const cutoff = new Date(nextMeeting.getTime() - 2 * day);

  // A completed meeting so the archive isn't empty.
  const past = await db.run(
    "INSERT INTO meetings(title,meeting_at,cutoff_at,status,minutes,created_by,created_at) VALUES ($1,$2,$3,'completed',$4,'perryh',$5) RETURNING id",
    ["House Meeting #11", new Date(now - 9 * day), new Date(now - 11 * day), "## Minutes\n\n- Called to order 9:02pm\n- Approved snacks for study break\n- Adjourned 9:40pm", new Date(now - 20 * day)]
  );
  const m = await db.run("INSERT INTO meetings(title,meeting_at,cutoff_at,preface,created_by) VALUES ($1,$2,$3,$4,'perryh') RETURNING id", [
    "House Meeting #12",
    nextMeeting,
    cutoff,
    "Snacks provided! Meetings are open to all residents.",
  ]);
  const mid = m.rows[0].id;
  for (const [i, t] of ["House Chair's Announcements", "President's Announcements", "Committee Reports"].entries()) {
    await db.run("INSERT INTO agenda_items(meeting_id,sort,kind,title,body) VALUES ($1,$2,'block',$3,$4)", [
      mid,
      i + 1,
      t,
      i === 0 ? "- Welcome back!\n- Elections open next week" : "",
    ]);
  }

  const props = [
    { author: "alice", title: "Social - Fall Study Break", type: "fundrequest", amount: "350.00", account: null, summary: "Fund a study break before finals with pizza and boba for about 120 residents.", text: "The House allocates **$350** from the proposal account to the Social Committee for a study break on the Friday before finals." },
    { author: "bob", title: "Tech - Replace lounge projector", type: "fundrequest", amount: "800", account: "1234567", summary: "The lounge projector is dying. Replace it with a 4K short-throw model.", text: "The House allocates $800 from the lounge account to purchase a replacement projector for the main lounge." },
    { author: "carol", title: "Quiet hours during finals", type: "policy", summary: "Extend quiet hours to 24/7 during the finals period.", text: "During the official finals period, quiet hours are in effect at all times in residential hallways." },
    { author: "dave", title: "Bike room cleanup", type: "announcement", summary: "Unclaimed bikes will be removed on Dec 1. Tag yours!", text: "Bikes without a tag will be donated after December 1." },
  ];
  for (const [i, p] of props.entries()) {
    const r = await db.run(
      "INSERT INTO proposals(author,title,type,summary,full_text,final_text,status,meeting_id) VALUES ($1,$2,$3,$4,$5,$5,$6,$7) RETURNING id",
      [p.author, p.title, p.type, p.summary, p.text, i < 2 ? "agenda" : "open", i < 2 ? mid : null]
    );
    const pid = r.rows[0].id;
    if (p.amount) await db.run("INSERT INTO proposal_attachments(proposal_id,kind,amount,final_amount,account_number) VALUES ($1,'funding',$2,$2,$3)", [pid, p.amount, p.account ?? null]);
    await db.run("INSERT INTO proposal_log(proposal_id,actor,message) VALUES ($1,$2,'Submitted')", [pid, p.author]);
    if (i < 2) await db.run("INSERT INTO agenda_items(meeting_id,sort,kind,proposal_id) VALUES ($1,$2,'proposal',$3)", [mid, 10 + i, pid]);
  }
  const old = await db.run(
    "INSERT INTO proposals(author,title,type,summary,full_text,final_text,status,decision,meeting_id) VALUES ('erin','Snacks for study break','fundrequest','Snacks.','Allocate $60 for snacks.','Allocate $60 for snacks.','decided','APPROVED',$1) RETURNING id",
    [past.rows[0].id]
  );
  await db.run("INSERT INTO proposal_attachments(proposal_id,kind,amount,final_amount,account) VALUES ($1,'funding',60,60,'discretionary')", [old.rows[0].id]);
  await db.run("INSERT INTO agenda_items(meeting_id,sort,kind,proposal_id) VALUES ($1,1,'proposal',$2)", [past.rows[0].id, old.rows[0].id]);

  // A draft amendment for perryh.
  const base = await govdocs.head("constitution");
  await db.run("INSERT INTO amendments(doc_slug,author,title,base_commit,content) VALUES ('constitution','perryh','Add Tech Chair as an officer',$1,$2)", [
    base,
    CONSTITUTION.replace("Secretary and Treasurer", "Secretary, Treasurer and Tech Chair"),
  ]);

  // Polls: a secret referendum and a ranked-choice election.
  const ref = await db.run(
    "INSERT INTO polls(title,description,secret,show_live_results,opens_at,closes_at,created_by) VALUES ($1,$2,true,true,$3,$4,'perryh') RETURNING id",
    ["Full Forum: Quiet hours during finals", "Should quiet hours be 24/7 during finals? Requires a 2/3 majority.", new Date(now - day), new Date(now + 3 * day)]
  );
  await db.run("INSERT INTO poll_questions(poll_id,sort,type,prompt,options,config) VALUES ($1,0,'choice',$2,$3,$4)", [
    ref.rows[0].id,
    "Do you approve the proposal?",
    JSON.stringify([{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]),
    JSON.stringify({ threshold: 66.7, required: true }),
  ]);
  await db.run("INSERT INTO poll_questions(poll_id,sort,type,prompt,options,config) VALUES ($1,1,'text','Comments (optional)','[]','{\"required\":false}')", [ref.rows[0].id]);

  const el = await db.run(
    "INSERT INTO polls(title,description,secret,show_live_results,opens_at,closes_at,created_by) VALUES ($1,$2,true,false,$3,$4,'perryh') RETURNING id",
    ["Spring Officer Elections", "Rank as many candidates as you like. Click a name to read their statement.", new Date(now - day), new Date(now + 6 * day)]
  );
  await db.run("INSERT INTO poll_questions(poll_id,sort,type,prompt,options,config) VALUES ($1,0,'vote','President',$2,$3)", [
    el.rows[0].id,
    JSON.stringify([
      { id: "c1", label: "alice", statement: "I've served on Social for two years and want to make meetings shorter." },
      { id: "c2", label: "bob", statement: "Tech chair alum. I'll get the lounge projector fixed for good." },
      { id: "c3", label: "carol", statement: "More study breaks, better communication." },
    ]),
    JSON.stringify({ method: "irv", writeIn: true, required: true }),
  ]);
  await db.run("INSERT INTO poll_questions(poll_id,sort,type,prompt,options,config) VALUES ($1,1,'vote','Treasurer',$2,$3)", [
    el.rows[0].id,
    JSON.stringify([{ id: "t1", label: "dave", statement: "I like spreadsheets." }]),
    JSON.stringify({ method: "pick1", writeIn: true, threshold: 50, required: false }),
  ]);

  await db.setSetting(
    "orgchart",
    ["Executive", "  President: dave", "  House Chair: perryh", "    Secretary: alice", "    Treasurer: bob", "Committees", "  Social Chair: carol", "  Tech Chair: erin, frank"].join("\n")
  );
}
