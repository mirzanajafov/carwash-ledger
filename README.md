# Car Wash Ledger

In Breaking Bad, Saul and Skyler push money through a car wash, and the hard part isn't the washing, it's making every cent add up on paper when somebody looks. I wanted to build the honest version of that: a payments ledger for a chain of car washes where correctness is the whole product.

A payment that is retried, cut off by a crash or reported twice by the bank still moves each cent exactly once. The books always balance, and the database refuses anything that doesn't. Anyone who edits history behind the ledger's back gets caught, by a witness that lives outside the database and by your own browser. Most of my working life has been payment pipelines, Stripe and Kafka, and none of that is public. This takes the hardest part of that work and proves it with numbers instead of claims.

It runs at **[carwash.najafov.dev](https://carwash.najafov.dev)**: money moving through T-accounts as customers pay at the bays, a button that kills the API in the middle of a payment, a bank you can make flaky for five minutes, three ways to tamper with the books, and the measurements behind all of it.

![The live page: payments at the wash bays and the T-accounts they move](docs/screenshots/live.png)

What's real and what isn't: the payment provider and the bank are a simulator I wrote, the money and the customers are fake, and on the demo a settlement "day" lasts ten minutes. The ledger, its rules, the invariant checker and the audit log are the real thing. The witness that signs the audit log runs on the same server as the ledger, so on the demo it shows the mechanism, not a real separation of trust.

## The books

Every movement is a journal of entries that sum to zero per currency, in integer cents. Entries are never updated or deleted; a mistake is fixed with a reversing journal. I didn't want that to depend on the code being right, so the database enforces it:

- a deferred constraint trigger checks every journal at commit, so an unbalanced journal can't commit even if the code tries;
- the app's role has no `UPDATE` or `DELETE` on entries, and the owner's updates go through a trigger that refuses changes to any column that matters;
- every entry copies its account's currency, filled by a trigger and checked by the invariant checker.

The invariant checker is separate code with its own SQL, so a bug in the posting path can't hide behind the same bug in the check. It runs as a read-only role. Its checks:

- every journal sums to zero per currency (S1);
- every stored balance equals its entries (S2);
- every payment has exactly the capture and refund journals its state says (S3);
- the ledger agrees with what the bank actually did (S4);
- every key produced exactly one effect (S5);
- payouts never exceed what the merchant was owed in journal order (S6);
- the audit log matches the journals and the witness (S7);
- what clients were told is what the books say (S8);
- plus the liveness checks L1 to L5, things that have to be true once the faults stop.

## The hot account

Every payment touches the same two accounts: what the payment provider owes the platform, and the platform's fee. A plain balance row on those accounts becomes a lock that every payment in the system waits on. I measured four ways around it before picking one, with an open-loop load generator I checked against pgbench first.

Highest rate each one sustained at 32 connections, median of three runs (journals a second):

| how the balance is kept | highest achieved | what it costs |
|---|---|---|
| one locked row | 149 | each commit waits for the previous one to flush, about 3 ms on my laptop |
| one locked row, `synchronous_commit = off` | 529 | it can lose acknowledged payments, so it's only a diagnostic |
| `SERIALIZABLE` with retries | 132 | worse than the lock at every connection count, more than one retry per journal |
| derived from entries plus snapshots | 915 | reads sum a tail, and a long transaction makes that tail grow |
| split into 16 rows | 803 | reads sum 16 rows, and the account can't have a balance rule |

I chose the 16 rows. They carry about the same load as derived balances, but their reads stay cheap, and they don't depend on a snapshot horizon that one stuck transaction can hold back. The textbook answer, `SERIALIZABLE`, was the worst option on a hot row. I found one more thing I hadn't planned for: on a host that pages, about 0.1% of commits stall for around 100 ms, and behind a locked hot row that becomes everyone's p99. So every benchmark here runs on a quiet machine, behind a floor check that refuses to start otherwise.

The posting itself is one round trip of locks plus one CTE on plain `pg`. Prisma stays for the schema and the migrations; its query API took twice the round trips and 1.7 times the latency for the same journal.

## Payments

The API takes payments with Stripe's idempotency rules. An `Idempotency-Key` is stored with a hash of the request and the first answer: the same key and body get that answer back, the same key with a different body is refused, and two requests with one key at the same time produce one payment. A key is held by a lease while its request runs, and every write checks it still holds the lease. That fence came from the first chaos runs: without it, a slow request whose lease had expired could still create a second payment for its key.

A payment is a state machine: created, authorized, captured, refunded, canceled or failed. Every move is a conditional update, so it happens once. The bank's word is checked, not trusted. A webhook only tells the API to go and ask the provider what happened, and an answer with the wrong amount is refused and recorded as an anomaly for a person. A recovery job finishes whatever a crash left pending. On the admin page a person can accept the amount the bank really used, which pulls the operation from the bank again and posts it through the normal path, or dispute it, which moves no money. A payout is the awkward one, because its journal is posted before the bank is called; accepting a smaller payout posts an adjustment that gives the difference back to the merchant. The chaos runs accept them too, before the final checks, so that path is held to the same invariants.

## Events

Every journal writes its events to an outbox in the same transaction. A relay publishes them to Kafka, and the consumers, receipts with gapless numbers per merchant and daily statements, record every event id they apply. Delivery is at least once. The effect is exactly once, because a consumer that sees an event again does nothing. In one chaos run with three Postgres crashes, the relay published 3,368 events as 3,744 messages, and both consumers still applied each event once.

Kafka is a single broker in KRaft mode. Postgres is the record, so a broker that comes back empty loses nothing.

I measured the lag on the laptop (E4): five runs at each of 100, 500 and 2,000 events a second. An event reaches Kafka in about 20 ms at the median and 36-46 ms at p99, and that barely moves with the rate, because most of it is the relay's 50 ms poll. The consumer adds 10-36 ms on top. What does change with the rate is the cost: at 100 events a second each event costs 5.5 database transactions, at 2,000 it costs 1.35, because the relay and the consumer pay per batch. When I killed the broker for 30 s at 500 a second, about 25,000 events piled up in the outbox and drained in under 2 s once the relay reconnected. The slow part was everything around that: the broker took 13 s to start and the relay another 7 s to publish again, and latency stayed high for 24-57 s after that. Later the relay learned to back off when the outbox is empty (see below), and I ran the steady rates again: at 100 events a second p99 rose from 46 to 59 ms while each event cost a transaction less, and at 500 and 2,000 nothing moved beyond run-to-run noise.

## Reconciliation

Every day the provider sends a settlement file, and a matcher compares it with the books. I built a generator that injects six kinds of faults into those files at known rates, so I could measure the matcher instead of trusting it. Matching by the ledger's own reference finds every fault and reports no false breaks, at 50, 500 and 2,000 payments a day. The interesting case is a line that has lost its reference. Matching it on the amount and date sounds reasonable, but a car wash sells five prices, so thousands of payments a day look the same. Matching to the oldest open payment put 13-77% of those lines on the wrong payment and hid up to 46% of the missing lines. So the matcher only places such a line when exactly one payment fits, and otherwise leaves it for a person. That is never wrong, and it places 11-78% of them.

## The audit log

Every journal becomes a leaf, a hash of a fixed binary encoding of the journal, in an RFC 9162 Merkle tree, the same construction Certificate Transparency uses. Every complete subtree is stored once, so proofs read a logarithmic number of rows. A sequencer adds journals about a second after they commit; doing it at commit would make the log itself a hot row.

Every 10 seconds the worker asks a separate witness to sign the tree's root. The witness keeps the last root it signed and only signs a bigger tree with a proof that it extends the old one. So a ledger whose history was rewritten can't get a new signature. On the audit page you can try the three ways an insider would do it:

1. **Move a euro between two entries of one journal.** It still balances, so every balance check passes. The leaf no longer matches the rows.
2. **Do that, then rewrite the leaf, the chain and the tree**, so the database agrees with itself completely. Only the roots the witness signed catch it.
3. **Delete a journal.** Its leaf is still in the signed tree.

Then your browser checks one journal on its own. It recomputes the leaf from the rows, follows the server's proof to the root, and verifies the witness's Ed25519 signature with WebCrypto. The server only supplies data. A full verifier on the server does the same for every journal and names the first one that differs.

What it can't catch, honestly: a change in the second between a journal's commit and its sequencing, and a full rewrite done in the seconds before the next checkpoint. And the witness trusts the first root it ever sees.

![The audit page: the log, what the witness signed, and the three ways to tamper](docs/screenshots/audit.png)

I measured it on the laptop (E6) with a million journals seeded straight into the database. The sequencer turns 22,000-25,000 journals a second into leaves, and a checkpoint takes about 12 ms at any size. Verifying all million from scratch takes 31 s, about half reading rows and half hashing; checking only what was added since the last run takes 228 ms for 10,000 journals. A proof at a million journals is 15-20 hashes, at most 640 bytes. The log costs about 400 bytes a journal on disk, which is more than the journal row itself. Under 200 payments a second a journal waits half a second for the sequencer at the median and a full second at worst, which is just the interval it runs on.

Then I tampered with the log 3,000 times on a smaller one, 1,000 times per class, each in a transaction that was rolled back afterwards. Every tamper that touched a journal the witness had signed was caught and the right journal named, 2,704 of 2,704. The second class, where the database is rewritten to agree with itself, was caught 900 times out of 900 with the witness's roots and 0 times without them, which is the whole argument for the witness in one line. The same rewrite above the last checkpoint was never caught, 0 of 100. That is the gap I describe above, and now it has a number.

## Changing a big table while it takes payments

Adding the currency to entries is a real change and a stand-in for the technique. It is done in four steps: add the column with a trigger that fills it, backfill in small resumable batches, add a check constraint without validating it and then validate it, and set `NOT NULL`. Each step runs in its own transaction, because Postgres holds every lock until the end of a transaction, and validating in the same transaction would hold the exclusive lock through the whole scan. I measured it on 20 million entries (3.2 GB) under 200 payments a second (E7). The naive version, one `ALTER` plus one `UPDATE` in a transaction, took 8.2 minutes, and in that time 99.7% of 99,447 payments failed: the table was locked, and each request waited up to 10 s before giving up. The table also doubled in size until a 40 s `VACUUM`. The four steps took 20 minutes instead and refused nothing: 242,334 payments went through with a p99 of 34.5 ms against 16 ms before. It wasn't perfectly smooth. Two seconds went over 1 s, one of them while the check step ran a catch-up scan of all 20 million rows in the same batch as the `ALTER`, which made writers queue for up to 3.5 s. That step should do its catch-up in batches too; I found it here and haven't changed it yet.

## Does it hold?

The main evidence is a chaos harness. One container runs Postgres, Kafka, Toxiproxy, the payment provider, two API processes, the worker and the witness, and clients drive payment journeys with real retry behaviour against them. While they do, the harness:

- kills processes with `SIGKILL` at random and at 15 named points in the code;
- crashes Postgres and Kafka;
- cuts, slows and resets the network links;
- has the provider time out after doing the work, decline, misstate amounts, and send webhooks late, twice or out of order;
- forges correctly signed webhooks.

After each run the invariant checker reads everything.

On the demo, the plug page is a small public version: pick a point in the middle of a payment, the API kills itself there, the terminal retries with the same key, and the checks run afterwards. The same page can make the bank flaky or start a storm for five minutes.

![The plug page](docs/screenshots/plug.png)

The long campaign ran on the night of 15 October on the code that is deployed: 200 runs, 135,048 payment journeys, 8,792 process kills and 876 Postgres and Kafka crashes, 2,253 network faults and 9,108 forged webhooks, and no run broke an invariant. I set the target at 10,000 kills before running anything and got 9,668, so call it close. One run crashed the harness itself, not the ledger: Toxiproxy's API timed out on a reset, and two seeds never ran. Together with the shorter campaigns before it, that is 227 base runs without a violation. A zero only means something if the harness can see a violation, so every guard has a mutant: the same code with that one guard removed. Every mutant is caught, most in the first run, with two exceptions that are meant to survive. The first is M1, which removes a guard another one covers; it is caught at once when both are removed. The second is M7a, a control that changes nothing in the ledger-only harness.

![The evidence page: the chaos totals and every mutant with the run that caught it](docs/screenshots/evidence.png)

Running it found real bugs before anyone else could:

- a pooled `pg` client whose connection died crashed Node on the next Postgres restart;
- the unfenced idempotency lease above, which charged one key twice;
- a deadlock between row locks and an exhausted pool;
- a retry storm that kept the API busy with requests their clients had given up on;
- database outages answered as 500 instead of 503;
- consumers that held their Kafka partitions for 45 s after a crash.

Running it like production found more. Inside a container the API always gets pid 7, so the plug page never saw the API come back. Three queries ordered numbers as text, so '96' came before '337'. And the backup archived the witness after the database, so the restored ledger was one leaf short of what the witness had signed.

The server found two more the night after the first deploy. The stack sat at about one core while the demo took a payment every five seconds: four relay loops polled the outbox every 50 ms whether or not anything was there, a thousand index scans a second for two writes. The relay now backs off to a second when it finds nothing and goes back to 50 ms as soon as it publishes. And the live page had stalled. Its lookback query returned the oldest 500 journals of its window, so once the log passed about 500 journals, a new viewer got 500 old journals as if they were new and then nothing at all. Neither showed up in the tests, which never had more than a few hundred journals; there is a regression test now with 700.

The measurements are on the evidence page, read straight from the result files in this repository.

## How it fits together

```
traffic (car wash customers) ─> api (NestJS) ────> Postgres ─┐
dashboard (Next.js) ─────────────┘   │    ▲                   │ outbox, audit queue
                                     ▼    │ webhooks          ▼
                               payment provider (simulated)  worker ─> Kafka ─> consumers
                                     └─ settlement files ─>  ├─ sequencer ─> witness
                                                             └─ recovery, reconciliation
```

The web app is a backend for the browser: the browser only talks to the Next server, which holds the API keys and limits each visitor by address. The live page is a server-sent event stream that the API fills by polling once a second, and the plug and tamper buttons go through the same server. Visitors take turns on the plug, the checks and the bank's weather. On `/admin`, an admin key opens a session that skips the turns; the key itself is never stored, and the session token lives in an httpOnly, `SameSite=Strict` cookie that dies on logout, after 12 hours, or when the key is revoked.

## Running it

You need Docker, Node 24 and pnpm.

```bash
docker compose up -d postgres kafka
pnpm install
pnpm -r build
DATABASE_URL=postgresql://ledger_owner:ledger_owner@localhost:5449/ledger pnpm --filter @carwash/db migrate
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test && pnpm test:db
```

`.github/workflows/ci.yml` runs the same steps on a clean checkout, plus a three-run chaos smoke on every push.

The chaos harness and the benchmarks run in their own containers:

```bash
sh tools/chaos/run.sh --runs 5 --duration 30     # one smoke; MUTANT=M2 runs a mutant
sh tools/bench/run.sh src/floor.ts               # is the machine quiet enough to measure?
sh tools/bench/run.sh src/e6.ts --mode trials    # any experiment, see tools/bench/src
```

For the dashboard, start the provider, the API, the worker, the witness, the tamper service, the traffic and `pnpm --filter @carwash/web dev`, or run the whole production stack: `docker compose -f docker-compose.prod.yml up -d` after building the two images (`deploy/server.Dockerfile`, `apps/web/Dockerfile`), with the secrets in `.env`. On the server, `deploy/deploy.sh` backs up, fast-forwards, rebuilds, checks health and rolls back. `deploy/restore-check.sh` restores the latest backup into a throwaway Postgres and runs the invariants and the verifier against the archived witness.

## API at a glance

| | |
|---|---|
| `POST /v1/payments` | `{ amount, currency, merchant, token, capture? }` with an `Idempotency-Key` |
| `POST /v1/payments/:id/capture`, `/cancel`, `/refunds` | the state machine's moves |
| `POST /v1/payouts` | pays a merchant what it is owed (admin) |
| `POST /webhooks/psp` | the provider's webhook; the API pulls the truth from the provider |
| `POST /v1/settlements/:day/ingest`, `GET /v1/reconciliation/...` | settlement files and their breaks (admin) |
| `GET /v1/audit/head`, `/checkpoint`, `/checkpoints` | the tree and what the witness signed |
| `GET /v1/journals/:id`, `/v1/journals/:id/proof?tree_size=` | a journal's rows and its inclusion proof |
| `GET /v1/audit/consistency?first=&second=` | proof that one tree extends another |
| `GET /v1/live` | the dashboard's event stream |
| `POST /v1/admin/plug`, `/checks`, `/verify` | the dashboard's demo actions, limited globally |
| `POST /v1/admin/sessions`, `GET`/`DELETE /v1/admin/sessions/current` | an admin key opens a 12-hour session for the dashboard; sessions skip the global limits |
| `GET /v1/admin/anomalies`, `POST /v1/admin/anomalies/:id/accept`, `/dispute` | answers the API refused, and a person's decision on them |

## What's where

```
packages/ledger      posting, balances, the online backfill
packages/invariants  the checker, S1-S8 and L1-L5
packages/audit       canonical encoding, the Merkle tree and proofs (runs in the browser too)
packages/audit-pg    sequencer, checkpoints, verifier, tamper
packages/outbox      outbox, relay, consumers
packages/recon       the settlement matcher
apps/api             NestJS API and worker
apps/psp             the simulated payment provider
apps/witness         signs tree checkpoints
apps/tamper          the tamper demo's superuser service
apps/traffic         simulated customers
apps/web             the dashboard
tools/chaos          the chaos harness and its mutants
tools/bench          the experiments
tools/recon-eval     the reconciliation experiment
```

## Limits and next

One Postgres without a replica, one Kafka broker, and backups on the same disk as the database. That's fine for a demo and not for money. The witness runs on the same server as the ledger; it should sign somewhere I don't control, like a public transparency log or a git repository someone else watches. The sequencer is a single writer by design; it did 22,000-25,000 journals a second here, far above anything a car wash chain needs, but it is still one process. FX, chargebacks and disputes with the card networks aren't there.

If I did it again, I would give the online migration's check step its own batched catch-up from the start, and I would build the measurement harness for the laptop's memory before the first long campaign rather than during it.
