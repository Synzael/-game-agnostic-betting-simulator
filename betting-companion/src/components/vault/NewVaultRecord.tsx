import Link from "next/link";
import { TrophyCategory } from "@/engine/types";
import { TROPHY_PRESENTATIONS } from "./TrophyCard";

export function NewVaultRecord({
  categories,
}: {
  readonly categories: readonly TrophyCategory[];
}) {
  if (categories.length === 0) return null;

  return (
    <section
      className="card-gold relative overflow-hidden p-5 animate-fadeInUp"
      aria-label="New Vault Record"
      data-testid="new-vault-record"
    >
      <div className="absolute inset-x-6 top-2 h-px bg-gradient-to-r from-transparent via-[var(--gold)] to-transparent opacity-60" />
      <div className="text-[9px] uppercase tracking-[0.24em] text-gold">
        New Vault Record
      </div>
      <h2 className="mt-2 font-display text-2xl text-champagne">
        Preserved in the Vault
      </h2>
      <p className="mt-2 text-sm leading-6 text-secondary">
        {categories
          .map((category) => TROPHY_PRESENTATIONS[category].title)
          .join(" · ")}
      </p>
      <Link
        href="/vault"
        className="mt-4 inline-flex text-xs uppercase tracking-[0.14em] text-gold underline decoration-[var(--gold-dim)] underline-offset-4"
      >
        Open the Vault
      </Link>
    </section>
  );
}
