import * as React from "react";

interface IconProps {
  className?: string;
}

export function ComposioLogo({ className = "size-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" className="fill-violet-500/15 stroke-violet-500" strokeWidth="1.6" />
      <circle cx="8.5" cy="9.5" r="2.2" className="fill-violet-500" />
      <circle cx="15.5" cy="9.5" r="2.2" className="fill-indigo-400" />
      <circle cx="12" cy="15.5" r="2.2" className="fill-violet-500" />
      <path d="M10.4 10.7L13.6 10.7M9.6 11.4L11 13.8M14.4 11.4L13 13.8" className="stroke-violet-500" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function N8nLogo({ className = "size-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" className="fill-rose-500/15 stroke-rose-500" strokeWidth="1.6" />
      <circle cx="7" cy="12" r="2" className="fill-rose-500" />
      <circle cx="12" cy="8.5" r="2" className="fill-rose-500" />
      <circle cx="17" cy="12" r="2" className="fill-rose-500" />
      <circle cx="12" cy="15.5" r="2" className="fill-rose-400" />
      <path d="M8.8 11L10.3 9.7M13.7 9.7L15.2 11M8.8 13L10.3 14.3M13.7 14.3L15.2 13" className="stroke-rose-500" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function McpHubLogo({ className = "size-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" className="fill-emerald-500/15 stroke-emerald-500" strokeWidth="1.6" />
      <path d="M7.5 14.5L11 11L13.5 13.5L17 10" className="stroke-emerald-500" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="7.5" cy="14.5" r="1.5" className="fill-emerald-500" />
      <circle cx="17" cy="10" r="1.5" className="fill-emerald-500" />
      <path d="M12 6.5V8.5M12 15.5V17.5" className="stroke-emerald-500/70" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function TeamsLogo({ className = "size-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" className="fill-indigo-500/15 stroke-indigo-500" strokeWidth="1.6" />
      <rect x="6" y="7.5" width="8.5" height="9" rx="2" className="fill-indigo-500" />
      <path d="M8.5 10.5H12M10.25 10.5V14.5" className="stroke-white" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16.5" cy="9.5" r="1.7" className="fill-indigo-400" />
      <path d="M14.8 15.5C14.8 13.8 15.6 12.8 16.8 12.8C17.8 12.8 18.5 13.6 18.5 15.5" className="fill-indigo-400" />
    </svg>
  );
}

export function GitHubLogo({ className = "size-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" className="fill-slate-500/15 stroke-slate-400" strokeWidth="1.6" />
      <path
        d="M12 6.5C8.96 6.5 6.5 8.96 6.5 12C6.5 14.43 8.08 16.49 10.26 17.22C10.54 17.27 10.64 17.1 10.64 16.95V15.9C9.11 16.23 8.79 15.25 8.79 15.25C8.54 14.61 8.18 14.44 8.18 14.44C7.68 14.1 8.22 14.11 8.22 14.11C8.77 14.15 9.06 14.68 9.06 14.68C9.55 15.52 10.35 15.28 10.66 15.14C10.71 14.78 10.85 14.54 11.01 14.4C9.79 14.26 8.51 13.79 8.51 11.68C8.51 11.08 8.72 10.59 9.08 10.21C9.02 10.07 8.83 9.5 9.13 8.73C9.13 8.73 9.6 8.58 10.65 9.29C11.09 9.17 11.55 9.11 12.01 9.11C12.47 9.11 12.93 9.17 13.37 9.29C14.42 8.58 14.89 8.73 14.89 8.73C15.19 9.5 15 10.07 14.94 10.21C15.3 10.59 15.51 11.08 15.51 11.68C15.51 13.8 14.22 14.26 13 14.39C13.2 14.56 13.38 14.9 13.38 15.42V16.95C13.38 17.1 13.48 17.28 13.77 17.22C15.94 16.49 17.5 14.43 17.5 12C17.5 8.96 15.04 6.5 12 6.5Z"
        className="fill-current"
      />
    </svg>
  );
}

export function AzureDevOpsLogo({ className = "size-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" className="fill-sky-500/15 stroke-sky-500" strokeWidth="1.6" />
      <path d="M17.5 7.5V16.2L14 18.2L7.5 15.7V17.4L5.5 14.2L13.5 14.8V8.5L17.5 7.5Z" className="fill-sky-500" />
      <path d="M13.5 8.5L7.8 6.4L5.5 9.6V14.2L8.4 12.4V9.2L13.5 8.5Z" className="fill-sky-400" />
    </svg>
  );
}

export function AppBrandIcon({ id, className = "size-4" }: { id: string; className?: string }) {
  switch (id.toLowerCase()) {
    case "composio":
      return <ComposioLogo className={className} />;
    case "n8n":
      return <N8nLogo className={className} />;
    case "mcp-hub":
      return <McpHubLogo className={className} />;
    case "ms-teams":
      return <TeamsLogo className={className} />;
    case "github":
      return <GitHubLogo className={className} />;
    case "azure-devops":
      return <AzureDevOpsLogo className={className} />;
    case "jira":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <path d="M12.5 4L19 10.5L15.5 14L12.5 11L9.5 14L6 10.5L12.5 4Z" className="fill-blue-500" />
          <path d="M12.5 12L16.5 16L12.5 20L8.5 16L12.5 12Z" className="fill-blue-400" />
        </svg>
      );
    case "slack":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect x="9.5" y="4" width="2.2" height="6" rx="1.1" className="fill-emerald-500" />
          <rect x="12.5" y="14" width="2.2" height="6" rx="1.1" className="fill-amber-500" />
          <rect x="4" y="12.5" width="6" height="2.2" rx="1.1" className="fill-sky-500" />
          <rect x="14" y="9.5" width="6" height="2.2" rx="1.1" className="fill-rose-500" />
        </svg>
      );
    case "linear":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <circle cx="12" cy="12" r="8" className="stroke-indigo-400" strokeWidth="1.8" />
          <path d="M6.5 14.5L14.5 6.5M8.5 16.5L16.5 8.5" className="stroke-indigo-400" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "notion":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect x="5" y="4" width="14" height="16" rx="2" className="stroke-current" strokeWidth="1.7" />
          <path d="M9 16V8L15 16V8" className="stroke-current" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return <PlugGlyph className={className} />;
  }
}

function PlugGlyph({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="7" className="stroke-primary" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="2.5" className="fill-primary" />
    </svg>
  );
}
