import { SlideInItem } from "@open-motion/components";
import { BASE, ANIM, scaled } from "../constants";

export function TableElement({
  element,
  index,
  scale: s,
}: {
  element: { headers: string[]; rows: string[][]; animation: string };
  index: number;
  scale: number;
}) {
  const delay = index * ANIM.staggerDelay;

  return (
    <table
      style={{
        borderCollapse: "collapse",
        width: "100%",
        fontSize: scaled(BASE.fontTable, s),
      }}
    >
      <thead>
        <tr>
          {element.headers.map((header, hi) => (
            <th
              key={hi}
              style={{
                backgroundColor: "#2d2d5e",
                color: "#ffffff",
                padding: `${scaled(10, s)}px ${scaled(16, s)}px`,
                textAlign: "left",
                border: "1px solid #444",
              }}
            >
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {element.rows.map((row, rowIndex) => {
          const rowContent = row.map((cell, ci) => (
            <td
              key={ci}
              style={{
                padding: `${scaled(8, s)}px ${scaled(16, s)}px`,
                border: "1px solid #333",
                color: "#e0e0e0",
              }}
            >
              {cell}
            </td>
          ));

          if (element.animation === "none") {
            return <tr key={rowIndex}>{rowContent}</tr>;
          }

          return (
            <SlideInItem
              key={rowIndex}
              index={rowIndex}
              delay={delay}
              stagger={ANIM.tableRowDelay}
              distance={30}
            >
              <tr>{rowContent}</tr>
            </SlideInItem>
          );
        })}
      </tbody>
    </table>
  );
}
