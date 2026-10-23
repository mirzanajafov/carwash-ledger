import { applyDecorators } from '@nestjs/common'
import { Transform, type TransformFnParams } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateBy } from 'class-validator'
import { CURRENCY_CODE } from '../currency.ts'
import { CAPTURE_MODES, type CaptureMode } from '../payments/payment.ts'

const MAX_AMOUNT = 100_000_000_000
const MAX_DAY = 999_999_999_999
const MAX_TREE_SIZE = 999_999_999_999_999
const MAX_ID = 999_999_999_999_999
const ACCOUNT_CODE = /^[\w:-]{1,200}$/
const CODE = /^[a-z0-9_-]{1,64}$/

function IsCurrencyCode() {
  return Matches(CURRENCY_CODE, { message: 'currency must be a three-letter currency code' })
}

function WholeNumber(min: number, max: number, message: string) {
  const parse = ({ value }: TransformFnParams): unknown => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value)
  const inRange = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
  return applyDecorators(Transform(parse), ValidateBy({ name: 'wholeNumber', validator: { validate: inRange, defaultMessage: () => message } }))
}

export class CreatePaymentBody {
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT)
  amount!: number

  @IsCurrencyCode()
  currency!: string

  @Matches(CODE, { message: 'merchant must be a merchant code' })
  merchant!: string

  @IsString()
  @Length(1, 200)
  token!: string

  @IsOptional()
  @IsIn(CAPTURE_MODES)
  capture?: CaptureMode
}

export class CaptureBody {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT)
  amount?: number
}

export class RefundBody {
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT)
  amount!: number
}

export class PayoutBody {
  @Matches(CODE, { message: 'merchant must be a merchant code' })
  merchant!: string

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT)
  amount?: number

  @IsCurrencyCode()
  currency!: string
}

export class MerchantBody {
  @Matches(CODE, { message: 'code must be 1 to 64 lowercase letters, digits, dashes or underscores' })
  code!: string

  @IsString()
  @Length(1, 100)
  name!: string

  @IsCurrencyCode()
  currency!: string
}

const PLUGS = ['post.after_lock', 'attempt.after_psp', 'transaction.before_commit', 'transaction.after_commit', 'request.before_finish'] as const

export class PlugBody {
  @IsIn(PLUGS)
  failpoint!: (typeof PLUGS)[number]
}

export class CurrencyQuery {
  @IsCurrencyCode()
  currency = 'EUR'
}

export class DaysQuery extends CurrencyQuery {
  @WholeNumber(1, 60, 'limit must be between 1 and 60')
  limit = 7
}

export class BreaksQuery extends CurrencyQuery {
  @WholeNumber(0, MAX_DAY, 'from must be a day number')
  from!: number

  @IsOptional()
  @WholeNumber(0, MAX_DAY, 'through must be a day number')
  through?: number
}

export class DayParams {
  @WholeNumber(0, MAX_DAY, 'day must be a day number')
  day!: number
}

export class AnomaliesQuery {
  @IsIn(['open', 'resolved'], { message: 'state must be open or resolved' })
  state: 'open' | 'resolved' = 'open'

  @WholeNumber(1, 200, 'limit must be between 1 and 200')
  limit = 50
}

export class AnomalyParams {
  @WholeNumber(1, MAX_ID, 'the anomaly id must be a number')
  id!: number
}

export class PaymentParams {
  @IsUUID('all', { message: 'the payment id must be a UUID' })
  id!: string
}

export class MerchantParams {
  @Matches(CODE, { message: 'code must be 1 to 64 lowercase letters, digits, dashes or underscores' })
  code!: string
}

export class AccountParams {
  @Matches(ACCOUNT_CODE, { message: 'code must be an account code' })
  code!: string
}

export class SeqParams {
  @WholeNumber(0, MAX_TREE_SIZE, 'seq must be a position in the log')
  seq!: number
}

export class JournalParams {
  @Matches(/^\d{1,18}$/, { message: 'the journal id must be a number' })
  id!: string
}

export class ProofQuery {
  @IsOptional()
  @WholeNumber(0, MAX_TREE_SIZE, 'tree_size must be a tree size')
  tree_size?: number
}

export class ConsistencyQuery {
  @WholeNumber(0, MAX_TREE_SIZE, 'first must be a tree size')
  first!: number

  @IsOptional()
  @WholeNumber(0, MAX_TREE_SIZE, 'second must be a tree size')
  second?: number
}
