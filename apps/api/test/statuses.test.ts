import type { $Enums } from '@carwash/db'
import type { AccountType, BalanceMode } from '@carwash/ledger'
import { describe, expectTypeOf, it } from 'vitest'
import type { VerificationStatus } from '../src/audit/verification-runs.ts'
import type { ClientScope } from '../src/auth/api-keys.ts'
import type { IdempotencyState } from '../src/idempotency/idempotency.service.ts'
import type { AttemptStatus } from '../src/payments/attempt.ts'
import type { CaptureMode, PaymentStatus, RefundStatus } from '../src/payments/payment.ts'
import type { PayoutStatus } from '../src/payouts/payout.ts'
import type { AttemptKind } from '../src/psp/answers.ts'

describe('the states the code knows', () => {
  it('are the ones the database schema declares', () => {
    expectTypeOf<AccountType>().toEqualTypeOf<$Enums.AccountType>()
    expectTypeOf<BalanceMode>().toEqualTypeOf<$Enums.BalanceMode>()
    expectTypeOf<ClientScope>().toEqualTypeOf<$Enums.ClientScope>()
    expectTypeOf<CaptureMode>().toEqualTypeOf<$Enums.CaptureMode>()
    expectTypeOf<PaymentStatus>().toEqualTypeOf<$Enums.PaymentStatus>()
    expectTypeOf<AttemptKind>().toEqualTypeOf<$Enums.AttemptKind>()
    expectTypeOf<AttemptStatus>().toEqualTypeOf<$Enums.AttemptStatus>()
    expectTypeOf<RefundStatus>().toEqualTypeOf<$Enums.RefundStatus>()
    expectTypeOf<PayoutStatus>().toEqualTypeOf<$Enums.PayoutStatus>()
    expectTypeOf<IdempotencyState>().toEqualTypeOf<$Enums.IdempotencyState>()
    expectTypeOf<VerificationStatus>().toEqualTypeOf<$Enums.VerificationStatus>()
  })
})
