import { definePlugin } from "@decky/api";
import { staticClasses } from "@decky/ui";
import { FaBolt } from "react-icons/fa";
import { Content } from "./Content";

export default definePlugin(() => ({
  name: "Zaparoo",
  titleView: <div className={staticClasses.Title}>Zaparoo</div>,
  content: <Content />,
  icon: <FaBolt />,
}));
