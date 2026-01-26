import { useAppContext } from "../../context/AppContext";
import { ARCHITECTURES } from "../../config/models";
import type { Architecture } from "../../types";

export const ArchitectureToggle = () => {
  const { config, updateArchitecture } = useAppContext();

  return (
    <div className="segmented-toggle">
      {(Object.keys(ARCHITECTURES) as Architecture[]).map((key) => (
        <button
          key={key}
          onClick={() => updateArchitecture(key)}
          className={`segment-btn ${config.architecture === key ? 'active' : ''}`}
        >
          {ARCHITECTURES[key].name}
        </button>
      ))}
    </div>
  );
};
