function OttleyAgent() {
  const [stage, setStage] = React.useState("intro"); // intro, question, results, contact
  const [businessType, setBusinessType] = React.useState("");
  const [suggestions, setSuggestions] = React.useState([]);

  const businessTypes = [
    { label: "Trades (plumbing, electrical, HVAC)", value: "trades", icon: "🔧" },
    { label: "Professional Services (accounting, legal, consulting)", value: "professional", icon: "💼" },
    { label: "Real Estate & Property", value: "realestate", icon: "🏠" },
    { label: "Hospitality & Restaurants", value: "hospitality", icon: "🍽️" },
    { label: "Retail & E-commerce", value: "retail", icon: "🛍️" },
    { label: "Health & Beauty", value: "health", icon: "💅" },
    { label: "Marketing & Agencies", value: "agencies", icon: "📱" },
    { label: "Other", value: "other", icon: "✨" },
  ];

  const automationMap = {
    trades: [
      "Lead capture from website inquiries",
      "Automated quote generation from job details",
      "Schedule optimization for service calls",
      "Customer follow-up & re-booking reminders",
      "Invoice generation from job completion",
    ],
    professional: [
      "Client intake & qualification forms",
      "Automated document drafting",
      "Proposal & quote generation",
      "Time tracking & invoice automation",
      "Meeting scheduling & confirmation",
    ],
    realestate: [
      "Lead capture from property inquiries",
      "Automated property recommendations",
      "Inspection scheduling & reminders",
      "Automated appraisal report generation",
      "Follow-up emails & nurture sequences",
    ],
    hospitality: [
      "Reservation & inquiry automation",
      "Menu optimization & pricing suggestions",
      "Staff scheduling optimization",
      "Customer feedback & review management",
      "Promotional campaign automation",
    ],
    retail: [
      "Product recommendation engine",
      "Abandoned cart recovery",
      "Customer support chatbot",
      "Inventory optimization",
      "Email marketing automation",
    ],
    health: [
      "Appointment scheduling automation",
      "Client intake forms & questionnaires",
      "Booking reminders & follow-ups",
      "Service recommendation engine",
      "Marketing automation for promotions",
    ],
    agencies: [
      "Lead qualification & nurture",
      "Project proposal generation",
      "Client reporting automation",
      "Time tracking & invoicing",
      "Content calendar automation",
    ],
    other: [
      "Email & task automation",
      "Document processing & extraction",
      "Customer communication workflows",
      "Data entry & form processing",
      "Scheduling & calendar optimization",
    ],
  };

  const handleBusinessSelect = (type) => {
    setBusinessType(type);
    setSuggestions(automationMap[type] || automationMap.other);
    setStage("results");
  };

  const handleReset = () => {
    setBusinessType("");
    setSuggestions([]);
    setStage("intro");
  };

  return (
    <section className="ottley-agent" data-screen-label="03 Ottley Agent">
      <div className="ottley-agent__container">
        <div className="ottley-agent__header">
          <div className="ottley-agent__avatar">
            <span className="ottley-agent__icon">🦉</span>
          </div>
          <h2 className="ottley-agent__title">Meet Ottley</h2>
          <p className="ottley-agent__subtitle">Your AI automation advisor</p>
        </div>

        {stage === "intro" && (
          <div className="ottley-agent__stage">
            <p className="ottley-agent__message">
              Hey there! I'm Ottley, and I'm here to show you exactly which AI automations could save your team hours this week.
            </p>
            <p className="ottley-agent__message">
              Tell me what your business does, and I'll suggest the automations that'll make the biggest impact.
            </p>
            <button
              className="btn btn--primary btn--lg"
              onClick={() => setStage("question")}
              style={{ marginTop: "2rem" }}
            >
              Let's find out <Arrow />
            </button>
          </div>
        )}

        {stage === "question" && (
          <div className="ottley-agent__stage">
            <p className="ottley-agent__message">
              What kind of business are you running?
            </p>
            <div className="ottley-agent__options">
              {businessTypes.map((type) => (
                <button
                  key={type.value}
                  className="ottley-agent__option"
                  onClick={() => handleBusinessSelect(type.value)}
                >
                  <span className="ottley-agent__option-icon">{type.icon}</span>
                  <span className="ottley-agent__option-label">{type.label}</span>
                  <span className="ottley-agent__option-arrow">→</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {stage === "results" && (
          <div className="ottley-agent__stage">
            <p className="ottley-agent__message">
              Perfect! Here's what AI could do for your business:
            </p>
            <ul className="ottley-agent__suggestions">
              {suggestions.map((suggestion, i) => (
                <li key={i} className="ottley-agent__suggestion">
                  <span className="ottley-agent__suggestion-check">✓</span>
                  <span>{suggestion}</span>
                </li>
              ))}
            </ul>
            <p className="ottley-agent__cta-text">
              Ready to explore these automations? Let's chat.
            </p>
            <div className="ottley-agent__actions">
              <a href="#contact" className="btn btn--primary btn--lg">
                Get in touch <Arrow />
              </a>
              <button
                className="btn btn--ghost btn--lg"
                onClick={handleReset}
              >
                Try another business
              </button>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .ottley-agent {
          padding: 6rem 2rem;
          background: linear-gradient(135deg, rgba(255, 77, 0, 0.05) 0%, rgba(255, 77, 0, 0.02) 100%);
          border-top: 1px solid rgba(255, 77, 0, 0.1);
          border-bottom: 1px solid rgba(255, 77, 0, 0.1);
        }

        .ottley-agent__container {
          max-width: 700px;
          margin: 0 auto;
        }

        .ottley-agent__header {
          text-align: center;
          margin-bottom: 3rem;
        }

        .ottley-agent__avatar {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 80px;
          height: 80px;
          background: rgba(255, 77, 0, 0.1);
          border-radius: 50%;
          margin-bottom: 1.5rem;
        }

        .ottley-agent__icon {
          font-size: 2.5rem;
        }

        .ottley-agent__title {
          font-size: 2rem;
          font-weight: 700;
          margin-bottom: 0.5rem;
        }

        .ottley-agent__subtitle {
          font-size: 1rem;
          opacity: 0.7;
        }

        .ottley-agent__stage {
          animation: fadeIn 0.3s ease-in;
        }

        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .ottley-agent__message {
          font-size: 1.1rem;
          line-height: 1.6;
          margin-bottom: 1.5rem;
          opacity: 0.9;
        }

        .ottley-agent__options {
          display: grid;
          grid-template-columns: 1fr;
          gap: 1rem;
          margin: 2rem 0;
        }

        .ottley-agent__option {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding: 1.25rem 1.5rem;
          border: 2px solid rgba(255, 77, 0, 0.2);
          border-radius: 8px;
          background: transparent;
          cursor: pointer;
          transition: all 0.2s ease;
          text-align: left;
          font-size: 0.95rem;
        }

        .ottley-agent__option:hover {
          border-color: var(--fire);
          background: rgba(255, 77, 0, 0.05);
          transform: translateX(4px);
        }

        .ottley-agent__option-icon {
          font-size: 1.5rem;
          flex-shrink: 0;
        }

        .ottley-agent__option-label {
          flex: 1;
          font-weight: 500;
        }

        .ottley-agent__option-arrow {
          opacity: 0.5;
          transition: opacity 0.2s;
        }

        .ottley-agent__option:hover .ottley-agent__option-arrow {
          opacity: 1;
        }

        .ottley-agent__suggestions {
          list-style: none;
          padding: 0;
          margin: 2rem 0;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .ottley-agent__suggestion {
          display: flex;
          align-items: flex-start;
          gap: 1rem;
          padding: 1rem;
          background: rgba(255, 77, 0, 0.08);
          border-radius: 6px;
          font-size: 0.95rem;
          line-height: 1.5;
        }

        .ottley-agent__suggestion-check {
          color: var(--fire);
          font-weight: 700;
          flex-shrink: 0;
          margin-top: 2px;
        }

        .ottley-agent__cta-text {
          text-align: center;
          margin: 2rem 0 1.5rem;
          opacity: 0.8;
        }

        .ottley-agent__actions {
          display: flex;
          gap: 1rem;
          justify-content: center;
          flex-wrap: wrap;
        }

        @media (max-width: 640px) {
          .ottley-agent {
            padding: 4rem 1rem;
          }

          .ottley-agent__actions {
            flex-direction: column;
          }

          .ottley-agent__actions .btn {
            width: 100%;
          }
        }
      `}</style>
    </section>
  );
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 13 L13 3 M6 3 H13 V10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

window.OttleyAgent = OttleyAgent;
