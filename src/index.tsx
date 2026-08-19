import { definePlugin } from "@decky/api";
import { staticClasses } from "@decky/ui";
import { FaBolt } from "react-icons/fa";
import { Content } from "./Content";
import { resetLogUploadLifecycle } from "./logUploadLifecycle";
import { closeAllModals, startModalLifecycle } from "./modalLifecycle";

export default definePlugin(() => {
  startModalLifecycle();
  return {
    name: "Zaparoo",
    titleView: <div className={staticClasses.Title}>Zaparoo</div>,
    content: <Content />,
    icon: <FaBolt />,
    onDismount: () => {
      closeAllModals();
      resetLogUploadLifecycle();
    },
  };
});
