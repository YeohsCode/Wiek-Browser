import { TicketRush } from "./ticket-rush";

export default function Home() {
  // The server-provided timestamp keeps relative event dates stable during hydration.
  // eslint-disable-next-line react-hooks/purity
  return <TicketRush referenceTimeMs={Date.now()} />;
}
