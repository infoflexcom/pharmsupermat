import React from 'react';

export type IconName =
  | 'dashboard'
  | 'pos'
  | 'wholesale'
  | 'sales'
  | 'returns'
  | 'products'
  | 'inventory'
  | 'reports'
  | 'users'
  | 'settings'
  | 'backup'
  | 'audit'
  | 'license'
  | 'logout'
  | 'plus'
  | 'search'
  | 'print'
  | 'check'
  | 'trash'
  | 'shield'
  | 'customers'
  | 'stock'
  | 'departments'
  | 'promotions'
  | 'loyalty'
  | 'shifts'
  | 'batches';

const PATHS: Record<IconName, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  pos: (
    <>
      <path d="M3 6h18l-1.6 9.5a2 2 0 0 1-2 1.7H7.6a2 2 0 0 1-2-1.7L4 6z" />
      <path d="M9 10v2.5M15 10v2.5M8 21h8" strokeLinecap="round" />
    </>
  ),
  wholesale: (
    <>
      <path d="M3 8l9-5 9 5v8l-9 5-9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </>
  ),
  sales: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M9 9h7M9 13h7M9 17h4" strokeLinecap="round" />
    </>
  ),
  returns: (
    <>
      <path d="M4 9a8 8 0 0 1 14-3l2 3" />
      <path d="M20 4v5h-5" />
      <path d="M20 15a8 8 0 0 1-14 3l-2-3" />
      <path d="M4 20v-5h5" />
    </>
  ),
  products: (
    <>
      <path d="M4 7l8-4 8 4v10l-8 4-8-4V7z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
    </>
  ),
  customers: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5" strokeLinecap="round" />
      <path d="M16 5.6a3 3 0 0 1 0 5.8M17.5 14.9c1.7.6 3 2.3 3 4.4" strokeLinecap="round" />
    </>
  ),
  stock: (
    <>
      <path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5v-7z" />
      <path d="M3 8.5 12 13l9-4.5M12 13v7" />
    </>
  ),
  departments: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.4" />
      <rect x="14" y="3" width="7" height="7" rx="1.4" />
      <rect x="3" y="14" width="7" height="7" rx="1.4" />
      <path d="M14 17.5h7M17.5 14v7" strokeLinecap="round" />
    </>
  ),
  promotions: (
    <>
      <path d="M20.5 12.5 12 21l-9-9V3h9l8.5 8.5a0.7 0.7 0 0 1 0 1z" />
      <circle cx="7.5" cy="7.5" r="1.4" />
    </>
  ),
  loyalty: (
    <>
      <path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.9z" />
    </>
  ),
  shifts: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.3l3.4 2" strokeLinecap="round" />
    </>
  ),
  batches: (
    <>
      <path d="M4 7h16v13H4z" />
      <path d="M4 7l3-3h10l3 3M9 12h6M9 16h6" strokeLinecap="round" />
    </>
  ),
  inventory: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" strokeLinecap="round" />
    </>
  ),
  reports: (
    <>
      <path d="M4 20V4M4 20h16" strokeLinecap="round" />
      <rect x="7" y="12" width="3" height="5" />
      <rect x="12" y="8" width="3" height="9" />
      <rect x="17" y="5" width="3" height="12" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c0-3 2.5-5.2 5.5-5.2s5.5 2.2 5.5 5.2" />
      <path d="M16 5.5a3 3 0 0 1 0 5.8M17 14.5c2.2.4 3.8 2.3 3.8 4.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M3 12h2.2M18.8 12H21M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" strokeLinecap="round" />
    </>
  ),
  backup: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  audit: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  license: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h5M7 14h3M16 9v6" strokeLinecap="round" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4H5v16h5" />
      <path d="M14 8l4 4-4 4M9 12h9" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" strokeLinecap="round" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
    </>
  ),
  print: (
    <>
      <path d="M7 8V3h10v5" />
      <rect x="4" y="8" width="16" height="8" rx="2" />
      <path d="M7 16h10v5H7z" />
    </>
  ),
  check: <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
    </>
  )
};

export function Icon({
  name,
  size = 18,
  className
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className={className}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
