/** "FTP" lettered icon for the activity bar (outlined like the other icons). */
export function FtpIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4.5" width="22" height="15" rx="3" strokeWidth="1.75" />
      <text
        x="12"
        y="15.6"
        textAnchor="middle"
        fontSize="10.5"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
        fill="currentColor"
        stroke="none"
      >
        FTP
      </text>
    </svg>
  );
}
