# Car Wash Ledger

In Breaking Bad, Saul and Skyler push money through a car wash, and the hard part isn't the washing, it's making every cent add up on paper when somebody looks. I wanted to build the honest version of that: a payments ledger for a chain of car washes where correctness is the whole product.

A payment that is retried, cut off by a crash or reported twice by the bank still moves each cent exactly once. The books always balance, and the database refuses anything that doesn't. Anyone who edits history behind the ledger's back gets caught, by a witness that lives outside the database and by your own browser. Most of my working life has been payment pipelines, Stripe and Kafka, and none of that is public. This takes the hardest part of that work and proves it with numbers instead of claims.

It runs at **[carwash.najafov.dev](https://carwash.najafov.dev)**: money moving through T-accounts as customers pay at the bays, a button that kills the API in the middle of a payment, three ways to tamper with the books, and the measurements behind all of it.

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

A payment is a state machine: created, authorized, captured, refunded, canceled or failed. Every move is a conditional update, so it happens once. The bank's word is checked, not trusted. A webhook only tells the API to go and ask the provider what happened, and an answer with the wrong amount is refused and recorded as an anomaly for a person. A recovery job finishes whatever a crash left pending.

## Events

Every journal writes its events to an outbox in the same transaction. A relay publishes them to Kafka, and the consumers, receipts with gapless numbers per merchant and daily statements, record every event id they apply. Delivery is at least once. The effect is exactly once, because a consumer that sees an event again does nothing. In one chaos run with three Postgres crashes, the relay published 3,368 events as 3,744 messages, and both consumers still applied each event once.

Kafka is a single broker in KRaft mode. Postgres is the record, so a broker that comes back empty loses nothing.

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

## Changing a big table while it takes payments

Adding the currency to entries is a real change and a stand-in for the technique. It is done in four steps: add the column with a trigger that fills it, backfill in small resumable batches, add a check constraint without validating it and then validate it, and set `NOT NULL`. Each step runs in its own transaction, because Postgres holds every lock until the end of a transaction, and validating in the same transaction would hold the exclusive lock through the whole scan. On a tiny trial the naive single-transaction version held its lock for 2 s and pushed p99 from 146 ms to 2 s; the four steps took longer and left p99 alone. The real measurement, 20 million entries under live load, is still to run.

## Does it hold?

The main evidence is a chaos harness. One container runs Postgres, Kafka, Toxiproxy, the payment provider, two API processes, the worker and the witness, and clients drive payment journeys with real retry behaviour against them. While they do, the harness:

- kills processes with `SIGKILL` at random and at 15 named points in the code;
- crashes Postgres and Kafka;
- cuts, slows and resets the network links;
- has the provider time out after doing the work, decline, misstate amounts, and send webhooks late, twice or out of order;
- forges correctly signed webhooks.

After each run the invariant checker reads everything.

So far: 27 runs, 74,388 journeys and journals, and 616 kills and crashes. No run broke an invariant. A zero only means something if the harness can see a violation, so every guard has a mutant: the same code with that one guard removed. Every mutant is caught, most in the first run, with two exceptions that are meant to survive. The first is M1, which removes a guard another one covers; it is caught at once when both are removed. The second is M7a, a control that changes nothing in the ledger-only harness.

Running it found real bugs before anyone else could:

- a pooled `pg` client whose connection died crashed Node on the next Postgres restart;
- the unfenced idempotency lease above, which charged one key twice;
- a deadlock between row locks and an exhausted pool;
- a retry storm that kept the API busy with requests their clients had given up on;
- database outages answered as 500 instead of 503;
- consumers that held their Kafka partitions for 45 s after a crash.

Running it like production found more. Inside a container the API always gets pid 7, so the plug page never saw the API come back. Three queries ordered numbers as text, so '96' came before '337'. And the backup archived the witness after the database, so the restored ledger was one leaf short of what the witness had signed.

## Measurements still to run

| | what | status |
|---|---|---|
| E4 | outbox lag to Kafka and to the consumers, and a 30 s broker outage | tooling done, waiting for a quiet night |
| E6 | verifying a million journals, proofs, the sequencer, 1,000 tamper trials per class | tooling done, waiting for a quiet night |
| E7 | the column change on 20 million entries under live payments | tooling done, waiting for a quiet night |
| chaos | a long campaign of a few hundred runs | waiting for a night |

The measurements I have are on the evidence page, read straight from the result files in this repository.

## How it fits together

```
traffic (car wash customers) ─> api (NestJS) ────> Postgres ─┐
dashboard (Next.js) ─────────────┘   │    ▲                   │ outbox, audit queue
                                     ▼    │ webhooks          ▼
                               payment provider (simulated)  worker ─> Kafka ─> consumers
                                     └─ settlement files ─>  ├─ sequencer ─> witness
                                                             └─ recovery, reconciliation
```

The web app is a backend for the browser: the browser only talks to the Next server, which holds the API keys and limits each visitor by address. The live page is a server-sent event stream that the API fills by polling once a second, and the plug and tamper buttons go through the same server.

## Running it

You need Docker, Node 24 and pnpm.

```bash
docker compose up -d postgres kafka
pnpm install
pnpm -r build
DATABASE_URL=postgresql://ledger_owner:ledger_owner@localhost:5449/ledger pnpm --filter @carwash/db migrate
pnpm -r test && pnpm test:db
```

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

One Postgres without a replica, one Kafka broker, and backups on the same disk as the database. That's fine for a demo and not for money. The witness should sign somewhere I don't control: a public transparency log or a git repository someone else can watch. FX, chargebacks and disputes aren't there. The sequencer is a single writer by design, and E6 will show where it stops. Next are the three measurements above, the long chaos campaign, and moving the witness's roots off this server.
