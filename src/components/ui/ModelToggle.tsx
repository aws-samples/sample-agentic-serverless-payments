import { useAppContext } from "../../context/AppContext";
import { NOVA_MODELS } from "../../config/models";
import type { NovaModel } from "../../types";

export const ModelToggle = () => {
  const { config, updateModel } = useAppContext();

  return (
    <select
      value={config.model}
      onChange={(e: any) => updateModel(e.target.value as NovaModel)}
      className="model-select"
    >
      {Object.entries(NOVA_MODELS).map(([key, value]) => (
        <option key={key} value={key}>
          {value.name}
        </option>
      ))}
    </select>
  );
};
