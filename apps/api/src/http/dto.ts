import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator'

const MAX_AMOUNT = 100_000_000_000
const CURRENCY = /^[A-Z]{3}$/
const CODE = /^[a-z0-9_-]{1,64}$/

export class CreatePaymentBody {
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT)
  amount!: number

  @Matches(CURRENCY, { message: 'currency must be a three-letter currency code' })
  currency!: string

  @Matches(CODE, { message: 'merchant must be a merchant code' })
  merchant!: string

  @IsString()
  @Length(1, 200)
  token!: string

  @IsOptional()
  @IsIn(['auto', 'manual'])
  capture?: 'auto' | 'manual'
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

  @Matches(CURRENCY, { message: 'currency must be a three-letter currency code' })
  currency!: string
}

export class MerchantBody {
  @Matches(CODE, { message: 'code must be 1 to 64 lowercase letters, digits, dashes or underscores' })
  code!: string

  @IsString()
  @Length(1, 100)
  name!: string

  @Matches(CURRENCY, { message: 'currency must be a three-letter currency code' })
  currency!: string
}

const PLUGS = ['post.after_lock', 'attempt.after_psp', 'transaction.before_commit', 'transaction.after_commit', 'request.before_finish'] as const

export class PlugBody {
  @IsIn(PLUGS)
  failpoint!: (typeof PLUGS)[number]
}
