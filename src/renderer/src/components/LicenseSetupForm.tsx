import type { Edition, LicenseStatus } from '../../../shared/types';
import { addYears, daysBetween, localDate } from '../../../shared/license-dates';
import { Field, Input } from './ui';

export interface LicenseSetupValue {
  edition: Edition;
  startsOn: string;
  endsOn: string;
}

export const EDITION_CHOICES: Array<{ value: Edition; title: string; product: string; blurb: string }> = [
  {
    value: 'PHARMACY',
    title: 'Pharmacy',
    product: 'Infoflex Pharm',
    blurb: 'Batches & expiry, prescriptions, pharmacy reports.'
  },
  {
    value: 'SUPERMARKET',
    title: 'Supermarket',
    product: 'Infoflex Mart',
    blurb: 'Departments, promotions, loyalty, shifts & drawer.'
  },
  {
    value: 'BOTH',
    title: 'Both editions',
    product: 'Infoflex Pharm & Mart',
    blurb: 'Every pharmacy and supermarket module in one install.'
  }
];

export function quickSelectEnd(startsOn: string, years: number): string {
  return addYears(startsOn, years);
}

export function periodLengthLabel(startsOn: string, endsOn: string): string {
  if (!startsOn || !endsOn) return '';
  const days = daysBetween(startsOn, endsOn);
  if (days <= 0) return '';
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Edition + licence period. Used by activation, the expired/renewal lock screen
 * and the in-app licence page, so all three behave identically.
 */
export function LicenseSetupForm({
  value,
  onChange,
  disabled,
  today
}: {
  value: LicenseSetupValue;
  onChange: (next: LicenseSetupValue) => void;
  disabled?: boolean;
  today?: string;
}) {
  const current = today ?? localDate();
  const set = (patch: Partial<LicenseSetupValue>) => onChange({ ...value, ...patch });
  const length = periodLengthLabel(value.startsOn, value.endsOn);
  const invalid = Boolean(value.startsOn && value.endsOn && value.endsOn <= value.startsOn);
  const endsInPast = Boolean(value.endsOn && value.endsOn <= current);

  return (
    <div className="stack">
      <div className="edition-grid" role="radiogroup" aria-label="Edition">
        {EDITION_CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={value.edition === choice.value}
            data-testid={`edition-${choice.value.toLowerCase()}`}
            className={`edition-card ${value.edition === choice.value ? 'active' : ''}`}
            onClick={() => set({ edition: choice.value })}
            disabled={disabled}
          >
            <span className="edition-title">{choice.title}</span>
            <span className="edition-product">{choice.product}</span>
            <span className="edition-blurb">{choice.blurb}</span>
          </button>
        ))}
      </div>

      <div className="form-grid two">
        <Field label="Start date">
          <Input
            type="date"
            value={value.startsOn}
            max={current}
            disabled={disabled}
            data-testid="license-start"
            onChange={(e) => set({ startsOn: e.target.value })}
          />
        </Field>
        <Field label="End date" hint="The app locks at 00:00 on the end date.">
          <Input
            type="date"
            value={value.endsOn}
            min={value.startsOn || current}
            disabled={disabled}
            data-testid="license-end"
            onChange={(e) => set({ endsOn: e.target.value })}
          />
        </Field>
      </div>

      <div className="row tight">
        {[1, 2, 3].map((years) => (
          <button
            key={years}
            type="button"
            className="chip"
            disabled={disabled}
            data-testid={`quick-${years}y`}
            onClick={() => set({ endsOn: quickSelectEnd(value.startsOn || current, years) })}
          >
            {years} year{years === 1 ? '' : 's'}
          </button>
        ))}
        <span className="spacer" />
        {length ? (
          <span className="tiny muted" data-testid="license-length">
            {length}
          </span>
        ) : null}
      </div>

      {invalid ? (
        <div className="tiny field-error">The end date must be after the start date.</div>
      ) : null}
      {endsInPast ? (
        <div className="tiny field-error">The end date must be in the future.</div>
      ) : null}
    </div>
  );
}

/** Small read-only summary used on the licence page and lock screen. */
export function LicensePeriodSummary({ license }: { license: LicenseStatus }) {
  if (!license.startsOn || !license.endsOn) return null;
  return (
    <div className="tiny muted">
      {license.startsOn} → {license.endsOn} (locks at 00:00 on the end date)
    </div>
  );
}
