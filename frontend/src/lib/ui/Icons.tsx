import type {ReactNode, SVGProps} from 'react'

/** Small stroke icon set (24x24 grid). Decorative: always aria-hidden. */
function Icon({children, size = 18, ...p}: {children: ReactNode; size?: number} & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...p}>
      {children}
    </svg>
  )
}

type P = {size?: number}
export const IconServer = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.01M7 17h.01" /></Icon>
export const IconKey = (p: P) => <Icon {...p}><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2 20 3m-3 3 3 3m-6-0 2 2" /></Icon>
export const IconForward = (p: P) => <Icon {...p}><path d="M4 12h13m-5-5 5 5-5 5" /><path d="M20 5v14" /></Icon>
export const IconData = (p: P) => <Icon {...p}><path d="M7 4v14m0 0-3-3m3 3 3-3M17 20V6m0 0-3 3m3-3 3 3" /></Icon>
export const IconCloud = (p: P) => <Icon {...p}><path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z" /></Icon>
export const IconGear = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Icon>
export const IconLock = (p: P) => <Icon {...p}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Icon>
export const IconPlus = (p: P) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>
export const IconSearch = (p: P) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>
export const IconFolder = (p: P) => <Icon {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Icon>
export const IconTerminal = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></Icon>
export const IconClose = (p: P) => <Icon {...p}><path d="M6 6l12 12M18 6 6 18" /></Icon>
export const IconEdit = (p: P) => <Icon {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /></Icon>
export const IconTrash = (p: P) => <Icon {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Icon>
export const IconPlay = (p: P) => <Icon {...p}><path d="M7 5v14l12-7z" /></Icon>
export const IconSplitH = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></Icon>
export const IconSplitV = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 12h18" /></Icon>
export const IconChevron = (p: P) => <Icon {...p}><path d="m9 6 6 6-6 6" /></Icon>
export const IconShield = (p: P) => <Icon {...p}><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z" /></Icon>
export const IconBraces = (p: P) => <Icon {...p}><path d="M8 4c-2 0-3 1-3 3v2c0 1.5-.8 2.5-2 3 1.2.5 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5.8 2.5 2 3-1.2.5-2 1.5-2 3v2c0 2-1 3-3 3" /></Icon>
export const IconCopy = (p: P) => <Icon {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></Icon>
export const IconEye = (p: P) => <Icon {...p}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Icon>
export const IconEyeOff = (p: P) => <Icon {...p}><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.4-1M9.9 9.9a3 3 0 0 0 4.2 4.2" /></Icon>
export const IconArrowUpRight = (p: P) => <Icon {...p}><path d="M7 17 17 7M8 7h9v9" /></Icon>
export const IconArrowUp = (p: P) => <Icon {...p}><path d="M12 19V5m-6 6 6-6 6 6" /></Icon>
export const IconArrowDown = (p: P) => <Icon {...p}><path d="M12 5v14m-6-6 6 6 6-6" /></Icon>
export const IconEnterKey = (p: P) => <Icon {...p}><path d="M20 5v7a3 3 0 0 1-3 3H5m0 0 4-4m-4 4 4 4" /></Icon>
export const IconWarn = (p: P) => <Icon {...p}><path d="M12 3 2 20h20zM12 10v5M12 17.5v.01" /></Icon>
export const IconCheckCircle = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5-6" /></Icon>
export const IconXCircle = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></Icon>
export const IconFile = (p: P) => <Icon {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></Icon>
export const IconUpload = (p: P) => <Icon {...p}><path d="M12 16V4m-5 5 5-5 5 5M5 20h14" /></Icon>
export const IconDownload = (p: P) => <Icon {...p}><path d="M12 4v12m-5-5 5 5 5-5M5 20h14" /></Icon>
export const IconRefresh = (p: P) => <Icon {...p}><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></Icon>
export const IconHome = (p: P) => <Icon {...p}><path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></Icon>
export const IconFolderPlus = (p: P) => <Icon {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 11v5M9.5 13.5h5" /></Icon>
export const IconMinus = (p: P) => <Icon {...p}><path d="M5 12h14" /></Icon>
export const IconUser = (p: P) => <Icon {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></Icon>

export const IconSerial = (p: P) => <Icon {...p}><path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" /></Icon>
export const IconFingerprint = (p: P) => <Icon {...p}><path d="M12 11v3.500c0 2 .8 3.900 2.200 5.300M8.500 13.500c0 3 1 5.200 2.500 6.800M5 12a7 7 0 0 1 14 0v1.500M8 8.500A5 5 0 0 1 17 12v2M12 7.500" /></Icon>
export const IconClock = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>
export const IconGrid = (p: P) => <Icon {...p}><rect x="4" y="4" width="7" height="7" rx="1.500" /><rect x="13" y="4" width="7" height="7" rx="1.500" /><rect x="4" y="13" width="7" height="7" rx="1.500" /><rect x="13" y="13" width="7" height="7" rx="1.500" /></Icon>
export const IconList = (p: P) => <Icon {...p}><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.500" cy="6" r="1" /><circle cx="4.500" cy="12" r="1" /><circle cx="4.500" cy="18" r="1" /></Icon>
export const IconBroadcast = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="2" /><path d="M7.500 7.500a6.400 6.400 0 0 0 0 9M16.500 7.500a6.400 6.400 0 0 1 0 9M4.800 4.800a10.200 10.200 0 0 0 0 14.400M19.200 4.800a10.200 10.200 0 0 1 0 14.400" /></Icon>
export const IconMaximizePane = (p: P) => <Icon {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Icon>
export const IconMinimizePane = (p: P) => <Icon {...p}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></Icon>
export const IconCapsLock = (p: P) => <Icon {...p}><path d="M12 4 4.500 12H9v4h6v-4h4.500z" /><path d="M9 20h6" /></Icon>
export const IconRocket = (p: P) => <Icon {...p}><path d="M5 19c-1 0-2-1-2-2 0-2 2-3 3-3l2 2c0 1-1 3-3 3zM9 15l-1-1c0-5 4-9 12-10 0 8-5 12-10 12zM15 9h.01" /></Icon>
export const IconPalette = (p: P) => <Icon {...p}><path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2-.6-1.2.2-2.5 1.5-2.5H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3zM7.5 11h.01M10 7.5h.01M14.5 7.5h.01" /></Icon>
export const IconSidebar = (p: P) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></Icon>
export const IconChevronDown = (p: P) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>
export const IconPlug = (p: P) => <Icon {...p}><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" /></Icon>
export const IconPopOut = (p: P) => <Icon {...p}><path d="M14 4h6v6M20 4l-8 8M10 6H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" /></Icon>
export const IconTag = (p: P) => <Icon {...p}><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9zM8 8h.01" /></Icon>
export const IconSparkle = (p: P) => <Icon {...p}><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></Icon>
export const IconPaperclip = (p: P) => <Icon {...p}><path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.6 8.6a2 2 0 0 1-3-3L15 7" /></Icon>
export const IconSend = (p: P) => <Icon {...p}><path d="M5 12h14m-6-6 6 6-6 6" /></Icon>
export const IconCheck = (p: P) => <Icon {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Icon>
export const IconChevronUp = (p: P) => <Icon {...p}><path d="m6 15 6-6 6 6" /></Icon>
